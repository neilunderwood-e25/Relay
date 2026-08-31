import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  OperationResult,
  OrchestratorInputReceipt,
  OrchestratorInputRequest,
  OrchestrationSnapshot,
  RelayControlCommand,
  TerminalSnapshot
} from '../shared/contracts';
import type { PendingControlCommand } from './hive';

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 100;
const QUIET_WINDOW_MS = 1_500;
const TURN_SETTLE_TIMEOUT_MS = 5 * 60_000;

type ControlCommandInput = Omit<RelayControlCommand, 'version' | 'id' | 'actor' | 'createdAt'>;

interface ControlHive {
  root: string;
  enqueueControl(command: RelayControlCommand): string;
  pendingControlCommands(): PendingControlCommand[];
  appendEvent(kind: string, payload: Record<string, unknown>): void;
}

interface ControlTerminals {
  list(): TerminalSnapshot[];
  submit(id: string, text: string): Promise<OperationResult>;
}

export interface RelayControlProtocolOptions {
  hive: ControlHive;
  terminals: ControlTerminals;
  logger: Logger;
  ensureTerminal(): Promise<TerminalSnapshot>;
  projectPath?: () => string;
  onDeliveryState?: (
    state: 'delivering' | 'settled' | 'failed',
    command: RelayControlCommand
  ) => void;
  now?: () => number;
  createId?: () => string;
}

export class RelayControlProtocol {
  private deliveryTail: Promise<void> = Promise.resolve();
  private readonly synchronizedRuns = new Map<string, string>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly options: RelayControlProtocolOptions) {}

  submitInput(request: OrchestratorInputRequest): OrchestratorInputReceipt {
    const id = this.nextId();
    const command = this.dispatch({
      kind: 'input.submitted',
      projectPath: this.options.projectPath?.() ?? '',
      runId: id,
      objective: request.text.trim(),
      strategy: request.strategy,
      payload: {
        providers: request.providers.join(','),
        profileIds: request.profileIds?.join(',') ?? '',
        templateId: request.templateId ?? '',
        concurrency: request.concurrency
      }
    }, 'human', id);
    return { id: command.id, status: 'queued', submittedAt: command.createdAt };
  }

  dispatch(
    input: ControlCommandInput,
    actor: RelayControlCommand['actor'] = 'human',
    id = this.nextId()
  ): RelayControlCommand {
    const command: RelayControlCommand = {
      ...input,
      version: 1,
      id,
      actor,
      createdAt: this.now()
    };
    const path = this.options.hive.enqueueControl(command);
    this.queueDelivery(command, path);
    return command;
  }

  recover(): number {
    const pending = this.options.hive.pendingControlCommands()
      .filter(({ command }) => !this.inFlight.has(command.id));
    for (const { command, path } of pending) {
      this.options.hive.appendEvent('control.recovered', {
        commandId: command.id,
        commandKind: command.kind,
        runId: command.runId
      });
      this.queueDelivery(command, path);
    }
    return pending.length;
  }

  async flush(): Promise<void> {
    await this.deliveryTail;
  }

  syncSnapshot(snapshot: OrchestrationSnapshot): RelayControlCommand | null {
    const verificationFinished = ['passed', 'failed'].includes(snapshot.run.verificationStatus ?? 'idle');
    const kind = verificationFinished
      ? 'run.verified'
      : snapshot.run.status === 'completed'
        ? 'run.completed'
        : snapshot.run.status === 'blocked'
          ? 'run.blocked'
          : snapshot.run.status === 'failed'
            ? 'run.failed'
            : null;
    const synchronizationKey = kind === 'run.verified'
      ? `${kind}:${snapshot.run.verificationStatus}`
      : kind;
    if (!kind || !synchronizationKey) {
      // A follow-up can reopen a completed run. Forget its terminal state so Michael
      // receives the newly reconciled completion instead of treating it as a duplicate.
      this.synchronizedRuns.delete(snapshot.run.id);
      return null;
    }
    if (this.synchronizedRuns.get(snapshot.run.id) === synchronizationKey) return null;
    this.synchronizedRuns.set(snapshot.run.id, synchronizationKey);
    return this.dispatch({
      kind,
      projectPath: snapshot.run.repoRoot,
      runId: snapshot.run.id,
      objective: snapshot.run.objective,
      strategy: snapshot.run.strategy,
      payload: {
        status: snapshot.run.status,
        taskCount: snapshot.tasks.length,
        completedTasks: snapshot.tasks.filter((task) => task.status === 'completed').length,
        integrationStatus: snapshot.run.integrationStatus ?? null,
        verificationStatus: snapshot.run.verificationStatus ?? null,
        summary: snapshot.run.finalSummary?.slice(0, 1_000) ?? null,
        error: snapshot.run.error ?? null
      }
    }, 'relay');
  }

  private async deliver(command: RelayControlCommand, path: string): Promise<void> {
    try {
      this.options.onDeliveryState?.('delivering', command);
      const ensured = await this.options.ensureTerminal();
      const terminal = await this.waitUntilReady(ensured.id);
      const result = await this.options.terminals.submit(
        terminal.id,
        controlWakePrompt(command, path, this.options.hive.root)
      );
      if (!result.ok) throw new Error(result.error ?? 'Michael did not accept the Relay control message.');
      this.options.hive.appendEvent('control.delivered', {
        commandId: command.id,
        commandKind: command.kind,
        runId: command.runId,
        terminalId: terminal.id
      });
      this.options.logger.info(
        { commandId: command.id, kind: command.kind, runId: command.runId, terminalId: terminal.id },
        'Relay control command delivered'
      );
      await this.waitForTurnToSettle(terminal.id, terminal.lastSequence);
      this.options.onDeliveryState?.('settled', command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.hive.appendEvent('control.delivery_failed', {
        commandId: command.id,
        commandKind: command.kind,
        runId: command.runId,
        error: message
      });
      this.options.logger.warn(
        { commandId: command.id, kind: command.kind, runId: command.runId, error: message },
        'Relay control command remains queued'
      );
      this.options.onDeliveryState?.('failed', command);
    }
  }

  private queueDelivery(command: RelayControlCommand, path: string): void {
    this.inFlight.add(command.id);
    const delivery = this.deliveryTail
      .catch(() => undefined)
      .then(() => this.deliver(command, path))
      .finally(() => this.inFlight.delete(command.id));
    this.deliveryTail = delivery;
  }

  private async waitUntilReady(id: string): Promise<TerminalSnapshot> {
    const startedAt = this.now();
    while (this.now() - startedAt < READY_TIMEOUT_MS) {
      const terminal = this.options.terminals.list().find((candidate) => candidate.id === id);
      if (!terminal || terminal.status === 'exited' || terminal.status === 'stopping') {
        throw new Error('Michael session exited before the control command could be delivered.');
      }
      const quietFor = terminal.lastOutputAt > 0 ? this.now() - terminal.lastOutputAt : 0;
      if (terminal.status === 'running' && terminal.hasOutput && quietFor >= QUIET_WINDOW_MS) return terminal;
      await delay(READY_POLL_MS);
    }
    throw new Error('Michael session did not become ready for Relay control.');
  }

  private async waitForTurnToSettle(id: string, previousSequence: number): Promise<void> {
    const startedAt = this.now();
    let sawResponse = false;
    while (this.now() - startedAt < TURN_SETTLE_TIMEOUT_MS) {
      const terminal = this.options.terminals.list().find((candidate) => candidate.id === id);
      if (!terminal || terminal.status === 'exited' || terminal.status === 'stopping') return;
      if (terminal.lastSequence > previousSequence) sawResponse = true;
      const quietFor = terminal.lastOutputAt > 0 ? this.now() - terminal.lastOutputAt : 0;
      if (sawResponse && quietFor >= QUIET_WINDOW_MS) return;
      if (!sawResponse && this.now() - startedAt >= 5_000) return;
      await delay(READY_POLL_MS);
    }
    this.options.hive.appendEvent('control.settle_timeout', { terminalId: id });
    this.options.logger.warn({ terminalId: id }, 'Michael control turn did not settle before the queue resumed');
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private nextId(): string {
    return this.options.createId?.() ?? `control-${randomUUID().slice(0, 12)}`;
  }

}

export function orchestratorSessionPrompt(
  orchestratorName: string,
  projectPath: string,
  hiveRoot: string
): string {
  return [
    `You are ${orchestratorName}, Relay's persistent orchestrator session.`,
    `The selected project is ${projectPath}.`,
    `Relay's durable hive is ${hiveRoot}.`,
    'Your working directory and only writable coordination area is the Hive. Treat the selected project as read-only context.',
    `Read ${hiveRoot}/PROTOCOL.md, ${hiveRoot}/agents/orchestrator/identity.md, ${hiveRoot}/agents/orchestrator/memory.md, and ${hiveRoot}/agents/orchestrator/context.md before handling a Relay control wake.`,
    'Relay main owns worktrees, worker processes, integration, and verification. Never change directory into or write to the selected project.',
    'Use the hive to stay aligned with Monitor. Never duplicate an active Monitor run or edit the main checkout while handling a control command.',
    `When you want Monitor to act, write one validated version-1 JSON request to ${hiveRoot}/control/outbox/action-<id>.json. Allowed kinds are run.create, run.stop, run.replan, task.retry, task.review, run.integrate, run.verify, and run.cleanup.`,
    `Relay writes action outcomes to ${hiveRoot}/control/results/. Never launch a worker or create a worktree directly.`,
    'A wake may be replayed after a restart. Check its acknowledgment and action result before doing anything; never repeat an action that already has a result.',
    'When a wake names a control file, read it, inspect board.md and tasks.json as needed, write a matching acknowledgment under control/.done, and answer briefly in this session.'
  ].join('\n');
}

export function controlWakePrompt(command: RelayControlCommand, path: string, hiveRoot: string): string {
  if (command.kind === 'input.submitted') {
    const actionId = `action-${command.id}`;
    const providers = String(command.payload.providers ?? '').split(',').filter(Boolean);
    const profileIds = String(command.payload.profileIds ?? '').split(',').filter(Boolean);
    const suggestedAction = {
      version: 1,
      id: actionId,
      kind: 'run.create',
      createdAt: command.createdAt,
      inputId: command.id,
      objective: command.objective,
      strategy: command.strategy,
      providers,
      concurrency: command.payload.concurrency,
      ...(profileIds.length > 0 ? { profileIds } : {}),
      ...(command.payload.templateId ? { templateId: command.payload.templateId } : {})
    };
    return [
      `[RELAY INPUT ${command.id}]`,
      `Read ${path}.`,
      'This is the human’s single input to you. Decide whether it needs a Monitor run or only a concise answer.',
      'For coding work, write the following JSON exactly as one file, then let Relay execute it:',
      `${hiveRoot}/control/outbox/${actionId}.json`,
      JSON.stringify(suggestedAction),
      'For an answer-only request, do not create an action. Never edit the project or launch workers yourself.',
      `Write ${hiveRoot}/control/.done/${command.id}.json with the command id, handledAt time, and a short summary, then answer the human in this session.`
    ].join('\n');
  }
  return [
    `[RELAY CONTROL ${command.id}]`,
    `Read ${path}.`,
    `Use ${hiveRoot}/PROTOCOL.md, board.md, tasks.json, and messages.jsonl as the authoritative Relay state.`,
    'Relay main is already executing this Monitor command. Do not duplicate workers or edit the main checkout.',
    `After handling it, write ${hiveRoot}/control/.done/${command.id}.json with the command id, handledAt time, and a short summary; keep the inbox file unchanged and briefly acknowledge ${command.kind}.`
  ].join('\n');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
