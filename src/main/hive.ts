import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HiveCoordinationMessage,
  HiveHealth,
  OrchestratorActionRequest,
  OrchestrationSnapshot,
  OrchestrationTaskStatus,
  ProviderId,
  RelayControlCommand
} from '../shared/contracts';
import type { OrchestratorActionResult } from '../shared/contracts';
import { personNameForSeed } from '../shared/agentIdentity';
import { orchestratorModelLabel } from '../shared/orchestratorModels';

interface HiveRegistry {
  version: 1;
  orchestratorId: 'orchestrator';
  agents: Record<string, {
    id: string;
    name: string;
    role: string;
    status: 'idle' | 'working' | 'blocked';
    directory: string;
    lastSeen: number;
  }>;
}

interface HiveLedger {
  version: 1;
  tasks: HiveTaskCard[];
}

interface HiveTaskCard {
  id: string;
  runId: string;
  source: string;
  title: string;
  description: string;
  deliverable: string;
  assignee: string;
  provider: string;
  role: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  branch?: string;
  worktreePath?: string;
  result?: string;
  error?: string;
  blocker?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedControlAction {
  fileName: string;
  path: string;
  request: unknown;
}

export interface PendingControlCommand {
  command: RelayControlCommand;
  path: string;
}

export interface HiveMemoryEntry {
  id: string;
  kind: 'input' | 'action' | 'run' | 'recovery';
  summary: string;
  createdAt: number;
  runId?: string;
  actionId?: string;
}

interface ControlActionJournal {
  version: 1;
  actionId: string;
  kind: string;
  state: 'executing' | 'completed' | 'rejected';
  startedAt: number;
  completedAt?: number;
  result?: OrchestratorActionResult;
}

function protocol(orchestratorName: string): string {
  return `# Relay hive protocol

The hive is Relay's durable coordination space. The Electron main process owns shared files.

## ${orchestratorName} workspace

- \`identity.md\` defines the orchestrator role.
- \`memory.md\` stores durable decisions and context.
- \`context.md\` is Relay's compact restart brief, projected from \`history.jsonl\`.
- \`inbox/\` receives messages; handled messages move to \`inbox/.done/\`.
- \`outbox/\` holds outgoing messages; delivered messages move to \`outbox/.sent/\`.

## Shared state

- \`registry.json\` is the agent roster.
- \`board.md\` is ${orchestratorName}'s narrative plan.
- \`tasks.json\` is the structured task ledger.
- \`log.jsonl\` is the append-only event stream.
- \`messages.jsonl\` is the append-only worker-to-orchestrator message stream.

## Relay control

- \`control/inbox/\` contains structured Monitor commands for ${orchestratorName}.
- Read each command named by a Relay wake message, then write \`control/.done/<command-id>.json\` as its acknowledgment.
- Control inbox files are an immutable audit trail; never delete or move them.
- To ask Monitor to act, write one version-1 JSON request to \`control/outbox/<action-id>.json\`.
- Allowed actions are \`run.create\`, \`run.stop\`, \`run.replan\`, \`task.retry\`, \`task.review\`, \`run.integrate\`, \`run.verify\`, and \`run.cleanup\`.
- Relay validates every action, executes accepted requests, and writes the outcome to \`control/results/<action-id>.json\`. Never launch workers or create worktrees yourself.
- \`control/actions/\` is Relay's execution journal. An action left in \`executing\` after a restart is quarantined instead of repeated.
- Relay's main process owns worktrees, worker launch, integration, and verification.
- Never duplicate a Monitor run or edit the main checkout while handling a control command.

Workers must never write into another agent's directory. ${orchestratorName}'s model-driven plans and outcomes are projected onto the shared board and task ledger by Relay.
`;
}

export class HiveManager {
  private ready = false;
  private error: string | undefined;
  private currentStatus: 'idle' | 'working' | 'blocked' = 'idle';

  constructor(
    readonly root: string,
    private orchestratorName: string,
    private orchestratorProvider: ProviderId = 'claude',
    private orchestratorModel: string | null = null
  ) {}

  get agentRoot(): string {
    return join(this.root, 'agents', 'orchestrator');
  }

  ensure(): HiveHealth {
    try {
      const legacyRoot = join(this.root, 'agents', 'rehan');
      if (existsSync(legacyRoot) && !existsSync(this.agentRoot)) renameSync(legacyRoot, this.agentRoot);
      mkdirSync(join(this.agentRoot, 'inbox', '.done'), { recursive: true });
      mkdirSync(join(this.agentRoot, 'outbox', '.sent'), { recursive: true });
      mkdirSync(join(this.root, 'control', 'inbox'), { recursive: true });
      mkdirSync(join(this.root, 'control', '.done'), { recursive: true });
      mkdirSync(join(this.root, 'control', 'outbox', '.processing'), { recursive: true });
      mkdirSync(join(this.root, 'control', 'outbox', '.done'), { recursive: true });
      mkdirSync(join(this.root, 'control', 'results'), { recursive: true });
      mkdirSync(join(this.root, 'control', 'actions'), { recursive: true });
      this.assertSafeTopology();
      this.atomicWrite(join(this.root, 'PROTOCOL.md'), protocol(this.orchestratorName));
      this.writeIfMissing(join(this.root, 'board.md'), `# Relay board\n\n_${this.orchestratorName} owns this shared plan._\n`);
      this.migrateLegacyBoard();
      this.writeJsonIfMissing(join(this.root, 'tasks.json'), { version: 1, tasks: [] });
      this.writeIfMissing(join(this.root, 'log.jsonl'), '');
      this.writeIfMissing(join(this.root, 'messages.jsonl'), '');
      this.writeIfMissing(
        join(this.agentRoot, 'memory.md'),
        `# ${this.orchestratorName} memory\n\n_Append durable decisions, project context, and coordination lessons here._\n`
      );
      this.writeIfMissing(join(this.agentRoot, 'history.jsonl'), '');
      this.writeRecoveryContext(this.readMemoryEntries(join(this.agentRoot, 'history.jsonl')).slice(-30));
      this.writeJsonIfMissing(join(this.agentRoot, 'cursor.json'), { lastProcessed: null });
      this.writeIfMissing(join(this.agentRoot, '.gitignore'), 'settings.json\ncursor.json\ninbox/\noutbox/\n');
      this.atomicWrite(
        join(this.agentRoot, 'identity.md'),
        [
          `# ${this.orchestratorName}`,
          '',
          '- Role: Relay orchestrator',
          `- Engine: ${this.orchestratorProvider === 'claude' ? 'Claude Code' : 'Codex CLI'}`,
          `- Model: ${orchestratorModelLabel(this.orchestratorProvider, this.orchestratorModel)}`,
          '- Owns: decomposition, assignment, task tracking, integration decisions, and final QA',
          '- Delegates implementation to CLI workers in isolated Git worktrees',
          '- Shared hive: ../../',
          ''
        ].join('\n')
      );
      this.refreshRegistry('idle');
      this.appendEvent('hive.ready', { agentId: 'orchestrator', name: this.orchestratorName });
      this.ready = true;
      this.error = undefined;
    } catch (cause) {
      this.ready = false;
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    return this.health();
  }

  health(): HiveHealth {
    return {
      ready: this.ready,
      path: this.root,
      agentPath: this.agentRoot,
      error: this.error
    };
  }

  renameOrchestrator(name: string): void {
    this.orchestratorName = name;
    if (!this.ready) return;
    this.atomicWrite(join(this.root, 'PROTOCOL.md'), protocol(this.orchestratorName));
    this.atomicWrite(
      join(this.agentRoot, 'identity.md'),
      [
        `# ${this.orchestratorName}`,
        '',
        '- Role: Relay orchestrator',
        `- Engine: ${this.orchestratorProvider === 'claude' ? 'Claude Code' : 'Codex CLI'}`,
        `- Model: ${orchestratorModelLabel(this.orchestratorProvider, this.orchestratorModel)}`,
        '- Owns: decomposition, assignment, task tracking, integration decisions, and final QA',
        '- Delegates implementation to CLI workers in isolated Git worktrees',
        '- Shared hive: ../../',
        ''
      ].join('\n')
    );
    this.writeRecoveryContext(this.readMemoryEntries(join(this.agentRoot, 'history.jsonl')).slice(-30));
    this.refreshRegistry(this.currentStatus);
    this.appendEvent('orchestrator.renamed', { agentId: 'orchestrator', name });
  }

  syncOrchestrations(snapshots: OrchestrationSnapshot[]): void {
    if (!this.ready) return;
    const ledger = this.readJson<HiveLedger>(join(this.root, 'tasks.json'), { version: 1, tasks: [] });
    const external = ledger.tasks.filter((task) => !['relay', 'foundry'].includes(task.source));
    const tasks = snapshots.flatMap((snapshot) => snapshot.tasks.map((task): HiveTaskCard => ({
      id: task.id,
      runId: task.runId,
      source: 'relay',
      title: task.title,
      description: task.instructions,
      deliverable: task.deliverable,
      assignee: task.agentName ?? personNameForSeed(task.id),
      provider: task.provider,
      role: task.role,
      status: ledgerStatus(task.status),
      dependsOn: [],
      branch: task.branch,
      worktreePath: task.worktreePath,
      result: task.summary,
      error: task.error,
      blocker: task.blocker,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString()
    })));
    this.atomicWriteJson(join(this.root, 'tasks.json'), { version: 1, tasks: [...external, ...tasks] });
    this.syncBoard(snapshots);

    const latest = snapshots[0]?.run;
    const status = latest && ['planning', 'queued', 'running', 'summarizing', 'stopping'].includes(latest.status)
      ? 'working'
      : latest && ['blocked', 'failed'].includes(latest.status)
        ? 'blocked'
        : 'idle';
    this.refreshRegistry(status);
    for (const snapshot of snapshots) {
      if (!['completed', 'blocked', 'failed', 'stopped'].includes(snapshot.run.status)) continue;
      const verification = snapshot.run.verificationStatus && snapshot.run.verificationStatus !== 'idle'
        ? `; verification ${snapshot.run.verificationStatus}`
        : '';
      this.appendMemory({
        id: `run:${snapshot.run.id}:${snapshot.run.status}:${snapshot.run.verificationStatus ?? 'idle'}`,
        kind: 'run',
        summary: `${snapshot.run.objective} — ${snapshot.run.finalSummary ?? snapshot.run.error ?? snapshot.run.status}${verification}`,
        createdAt: snapshot.run.updatedAt,
        runId: snapshot.run.id
      });
    }
  }

  appendEvent(kind: string, payload: Record<string, unknown>): void {
    if (!existsSync(this.root)) return;
    appendFileSync(join(this.root, 'log.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      ...payload,
      kind
    })}\n`, 'utf8');
  }

  appendMessage(message: HiveCoordinationMessage): void {
    if (!this.ready) return;
    const safe = {
      ...message,
      body: message.body.replace(/[\r\n]+/g, ' ').trim().slice(0, 2_000)
    };
    appendFileSync(join(this.root, 'messages.jsonl'), `${JSON.stringify(safe)}\n`, 'utf8');
    this.atomicWrite(
      join(this.agentRoot, 'inbox', `${safe.createdAt}-${safe.id}.json`),
      `${JSON.stringify(safe, null, 2)}\n`
    );
    this.appendEvent('hive.message', {
      messageId: safe.id,
      runId: safe.runId,
      taskId: safe.taskId,
      kind: safe.kind,
      from: safe.from
    });
  }

  enqueueControl(command: RelayControlCommand): string {
    if (!this.ready) throw new Error('The Relay hive is not ready.');
    if (!/^control-[a-z0-9-]+$/i.test(command.id)) throw new Error('Invalid Relay control id.');
    const path = join(this.root, 'control', 'inbox', `${command.createdAt}-${command.id}.json`);
    this.atomicWrite(path, `${JSON.stringify(command, null, 2)}\n`);
    this.appendEvent('control.queued', {
      commandId: command.id,
      commandKind: command.kind,
      runId: command.runId,
      taskId: command.taskId
    });
    if (command.kind === 'input.submitted') {
      this.appendMemory({
        id: `input:${command.id}`,
        kind: 'input',
        summary: command.objective,
        createdAt: command.createdAt,
        runId: command.runId
      });
    }
    return path;
  }

  pendingControlCommands(): PendingControlCommand[] {
    if (!this.ready) return [];
    const inbox = join(this.root, 'control', 'inbox');
    const acknowledged = join(this.root, 'control', '.done');
    return readdirSync(inbox)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .flatMap((fileName) => {
        const path = join(inbox, fileName);
        const command = this.readJson<RelayControlCommand | null>(path, null);
        if (!command || command.version !== 1 || !/^control-[a-z0-9-]+$/i.test(command.id)) return [];
        if (existsSync(join(acknowledged, `${command.id}.json`))) return [];
        return [{ command, path }];
      })
      .slice(-50);
  }

  claimControlActions(): ClaimedControlAction[] {
    if (!this.ready) return [];
    const outbox = join(this.root, 'control', 'outbox');
    const processing = join(outbox, '.processing');
    mkdirSync(processing, { recursive: true });
    for (const fileName of readdirSync(outbox).filter((name) => name.endsWith('.json')).sort()) {
      try {
        renameSync(join(outbox, fileName), join(processing, fileName));
      } catch {
        // Another drain may already own this request.
      }
    }
    return readdirSync(processing)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((fileName) => {
        const path = join(processing, fileName);
        let request: unknown;
        try {
          request = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        } catch {
          request = null;
        }
        return { fileName, path, request };
      });
  }

  completeControlAction(claim: ClaimedControlAction, result: OrchestratorActionResult): void {
    if (!this.ready) return;
    const resultPath = join(this.root, 'control', 'results', `${result.actionId}.json`);
    const durableResult = this.readJson<OrchestratorActionResult | null>(resultPath, null) ?? result;
    if (!existsSync(resultPath)) this.atomicWriteJson(resultPath, durableResult);
    const existing = this.readJson<ControlActionJournal | null>(
      join(this.root, 'control', 'actions', `${durableResult.actionId}.json`),
      null
    );
    this.atomicWriteJson(join(this.root, 'control', 'actions', `${durableResult.actionId}.json`), {
      version: 1,
      actionId: durableResult.actionId,
      kind: durableResult.kind,
      state: durableResult.status,
      startedAt: existing?.startedAt ?? durableResult.completedAt,
      completedAt: durableResult.completedAt,
      result: durableResult
    } satisfies ControlActionJournal);
    renameSync(claim.path, join(this.root, 'control', 'outbox', '.done', claim.fileName));
    this.appendEvent(`action.${durableResult.status}`, {
      actionId: durableResult.actionId,
      actionKind: durableResult.kind,
      runId: durableResult.runId,
      taskId: durableResult.taskId,
      error: durableResult.error
    });
    this.appendMemory({
      id: `action:${durableResult.actionId}:${durableResult.status}`,
      kind: 'action',
      summary: durableResult.status === 'completed'
        ? `${durableResult.kind}: ${durableResult.summary ?? 'completed'}`
        : `${durableResult.kind}: ${durableResult.error ?? 'rejected'}`,
      createdAt: durableResult.completedAt,
      runId: durableResult.runId,
      actionId: durableResult.actionId
    });
  }

  prepareControlAction(action: OrchestratorActionRequest): OrchestratorActionResult | null {
    if (!this.ready) throw new Error('The Relay hive is not ready.');
    const resultPath = join(this.root, 'control', 'results', `${action.id}.json`);
    const priorResult = this.readJson<OrchestratorActionResult | null>(resultPath, null);
    if (priorResult) return priorResult;

    const journalPath = join(this.root, 'control', 'actions', `${action.id}.json`);
    const journal = this.readJson<ControlActionJournal | null>(journalPath, null);
    if (journal?.state === 'executing') {
      return {
        version: 1,
        actionId: action.id,
        kind: action.kind,
        status: 'rejected',
        completedAt: Date.now(),
        runId: action.runId,
        taskId: action.taskId,
        error: 'Relay restarted while this action was executing. Inspect current state, then submit a new action if needed.'
      };
    }
    if (journal?.result) return journal.result;

    this.atomicWriteJson(journalPath, {
      version: 1,
      actionId: action.id,
      kind: action.kind,
      state: 'executing',
      startedAt: Date.now()
    } satisfies ControlActionJournal);
    this.appendEvent('action.executing', { actionId: action.id, actionKind: action.kind });
    return null;
  }

  recordRecovery(recoveredItems: number, replayedControls: number): void {
    if (recoveredItems < 1 && replayedControls < 1) return;
    this.appendMemory({
      id: `recovery:${Date.now()}`,
      kind: 'recovery',
      summary: `Relay recovered ${recoveredItems} interrupted item${recoveredItems === 1 ? '' : 's'} and queued ${replayedControls} control message${replayedControls === 1 ? '' : 's'} for replay.`,
      createdAt: Date.now()
    });
  }

  appendMemory(entry: HiveMemoryEntry): void {
    if (!this.ready) return;
    const path = join(this.agentRoot, 'history.jsonl');
    const entries = this.readMemoryEntries(path);
    if (entries.some((candidate) => candidate.id === entry.id)) return;
    const safe: HiveMemoryEntry = {
      ...entry,
      summary: entry.summary.replace(/[\r\n]+/g, ' ').trim().slice(0, 1_000)
    };
    appendFileSync(path, `${JSON.stringify(safe)}\n`, 'utf8');
    this.writeRecoveryContext([...entries, safe].slice(-30));
  }

  private syncBoard(snapshots: OrchestrationSnapshot[]): void {
    const latest = snapshots[0];
    const content = latest
      ? [
          '# Relay board',
          '',
          `_${this.orchestratorName} owns this shared plan._`,
          '',
          `## ${latest.run.objective}`,
          '',
          `- Status: ${latest.run.status}`,
          `- Strategy: ${latest.run.strategy}`,
          latest.run.planningSummary ? `- Plan: ${latest.run.planningSummary}` : '- Plan: preparing',
          latest.run.planningSource ? `- Source: ${latest.run.planningSource}` : '',
          latest.run.parentRunId ? `- Re-plan of: ${latest.run.parentRunId}` : '',
          latest.run.finalSummary ? `- Outcome: ${latest.run.finalSummary.replace(/\s+/g, ' ').slice(0, 500)}` : '',
          '',
          ...latest.tasks.map((task) =>
            `- [${task.status === 'completed' ? 'x' : ' '}] ${task.title} — ${task.agentName ?? personNameForSeed(task.id)} (${task.provider})${task.blocker ? ` — Blocked: ${task.blocker}` : ''}`
          ),
          ''
        ].filter(Boolean).join('\n')
      : `# Relay board\n\n_${this.orchestratorName} owns this shared plan._\n`;
    this.atomicWrite(join(this.root, 'board.md'), `${content}\n`);
  }

  private writeRecoveryContext(entries: HiveMemoryEntry[]): void {
    const lines = entries.length > 0
      ? entries.map((entry) => {
          const scope = entry.runId ? ` · ${entry.runId}` : '';
          return `- ${new Date(entry.createdAt).toISOString()} · ${entry.kind}${scope} — ${entry.summary}`;
        })
      : ['_No Relay activity has been recorded yet._'];
    this.atomicWrite(
      join(this.agentRoot, 'context.md'),
      [`# ${this.orchestratorName} recovery context`, '', 'Read `memory.md` for curated decisions. Recent Relay activity:', '', ...lines, ''].join('\n')
    );
  }

  private readMemoryEntries(path: string): HiveMemoryEntry[] {
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const entry = JSON.parse(line) as HiveMemoryEntry;
            return entry && typeof entry.id === 'string' ? [entry] : [];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  }

  private refreshRegistry(status: 'idle' | 'working' | 'blocked'): void {
    this.currentStatus = status;
    const path = join(this.root, 'registry.json');
    const registry = this.readJson<HiveRegistry>(path, { version: 1, orchestratorId: 'orchestrator', agents: {} });
    registry.version = 1;
    registry.orchestratorId = 'orchestrator';
    delete registry.agents.rehan;
    registry.agents.orchestrator = {
      id: 'orchestrator',
      name: this.orchestratorName,
      role: 'orchestrator',
      status,
      directory: this.agentRoot,
      lastSeen: Date.now()
    };
    registry.agents.claude = {
      id: 'claude',
      name: 'Claude',
      role: 'CLI worker',
      status: 'idle',
      directory: '',
      lastSeen: Date.now()
    };
    registry.agents.codex = {
      id: 'codex',
      name: 'Codex',
      role: 'CLI worker',
      status: 'idle',
      directory: '',
      lastSeen: Date.now()
    };
    this.atomicWriteJson(path, registry);
  }

  private writeIfMissing(path: string, content: string): void {
    if (!existsSync(path)) this.atomicWrite(path, content);
  }

  private assertSafeTopology(): void {
    for (const path of [
      this.root,
      join(this.root, 'agents'),
      this.agentRoot,
      join(this.agentRoot, 'inbox'),
      join(this.agentRoot, 'inbox', '.done'),
      join(this.agentRoot, 'outbox'),
      join(this.agentRoot, 'outbox', '.sent'),
      join(this.root, 'control'),
      join(this.root, 'control', 'inbox'),
      join(this.root, 'control', '.done'),
      join(this.root, 'control', 'outbox'),
      join(this.root, 'control', 'outbox', '.processing'),
      join(this.root, 'control', 'outbox', '.done'),
      join(this.root, 'control', 'results'),
      join(this.root, 'control', 'actions')
    ]) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe Hive directory: ${path}`);
      }
    }
    for (const path of [
      join(this.root, 'PROTOCOL.md'),
      join(this.root, 'board.md'),
      join(this.root, 'tasks.json'),
      join(this.root, 'log.jsonl'),
      join(this.root, 'messages.jsonl'),
      join(this.agentRoot, 'identity.md'),
      join(this.agentRoot, 'memory.md'),
      join(this.agentRoot, 'context.md'),
      join(this.agentRoot, 'history.jsonl'),
      join(this.agentRoot, 'cursor.json')
    ]) {
      if (!existsSync(path)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unsafe Hive file: ${path}`);
    }
  }

  private migrateLegacyBoard(): void {
    const path = join(this.root, 'board.md');
    const current = readFileSync(path, 'utf8');
    const migrated = current
      .replace(/^# Foundry board$/m, '# Relay board')
      .replace(/^_Rehan owns this shared plan\._$/m, `_${this.orchestratorName} owns this shared plan._`);
    if (migrated !== current) this.atomicWrite(path, migrated);
  }

  private writeJsonIfMissing(path: string, value: unknown): void {
    if (!existsSync(path)) this.atomicWriteJson(path, value);
  }

  private atomicWriteJson(path: string, value: unknown): void {
    this.atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}

function ledgerStatus(status: OrchestrationTaskStatus): HiveTaskCard['status'] {
  if (status === 'completed') return 'done';
  if (['blocked', 'failed', 'stopped'].includes(status)) return 'blocked';
  if (status === 'queued') return 'todo';
  return 'doing';
}
