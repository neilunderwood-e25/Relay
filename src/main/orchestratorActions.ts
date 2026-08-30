import type { Logger } from 'pino';
import type {
  OrchestratorActionKind,
  OrchestratorActionRequest,
  OrchestratorActionResult,
  OrchestrationStrategy,
  ProviderId
} from '../shared/contracts';
import type { ClaimedControlAction } from './hive';

const ACTION_KINDS: OrchestratorActionKind[] = [
  'run.create',
  'run.stop',
  'run.replan',
  'task.retry',
  'task.review',
  'run.integrate',
  'run.verify',
  'run.cleanup'
];
const STRATEGIES: OrchestrationStrategy[] = ['balanced', 'parallel', 'audit'];
const PROVIDERS: ProviderId[] = ['claude', 'codex'];

interface ActionHive {
  claimControlActions(): ClaimedControlAction[];
  prepareControlAction(action: OrchestratorActionRequest): OrchestratorActionResult | null;
  completeControlAction(claim: ClaimedControlAction, result: OrchestratorActionResult): void;
}

export interface OrchestratorActionBridgeOptions {
  hive: ActionHive;
  logger: Logger;
  execute(action: OrchestratorActionRequest): Promise<OrchestratorActionResult>;
  onResult?(action: OrchestratorActionRequest | null, result: OrchestratorActionResult): void | Promise<void>;
  now?: () => number;
  pollMs?: number;
}

/** Drains Michael's untrusted action outbox through Relay's validated execution boundary. */
export class OrchestratorActionBridge {
  private timer: NodeJS.Timeout | null = null;
  private drainTail: Promise<void> = Promise.resolve();
  private drainQueued = false;

  constructor(private readonly options: OrchestratorActionBridgeOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.queueDrain(), this.options.pollMs ?? 500);
    this.timer.unref();
    this.queueDrain();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async flush(): Promise<void> {
    this.queueDrain();
    await this.drainTail;
  }

  private queueDrain(): void {
    if (this.drainQueued) return;
    this.drainQueued = true;
    this.drainTail = this.drainTail
      .catch(() => undefined)
      .then(() => this.drain())
      .finally(() => { this.drainQueued = false; });
  }

  private async drain(): Promise<void> {
    for (const claim of this.options.hive.claimControlActions()) {
      let action: OrchestratorActionRequest | null = null;
      let result: OrchestratorActionResult;
      try {
        action = validateOrchestratorAction(claim.request);
        const recovered = this.options.hive.prepareControlAction(action);
        result = recovered ?? await this.options.execute(action);
      } catch (error) {
        const raw = isRecord(claim.request) ? claim.request : {};
        result = {
          version: 1,
          actionId: safeId(raw.id) ?? `rejected-${this.now()}`,
          kind: isActionKind(raw.kind) ? raw.kind : 'unknown',
          status: 'rejected',
          completedAt: this.now(),
          error: error instanceof Error ? error.message : String(error)
        };
      }
      try {
        this.options.hive.completeControlAction(claim, result);
        await this.options.onResult?.(action, result);
      } catch (error) {
        this.options.logger.error({ actionId: result.actionId, error }, 'Could not finalize Michael action');
        continue;
      }
      this.options.logger.info(
        { actionId: result.actionId, kind: result.kind, status: result.status },
        'Michael action processed'
      );
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function validateOrchestratorAction(value: unknown): OrchestratorActionRequest {
  if (!isRecord(value) || value.version !== 1) throw new Error('Michael action must use protocol version 1.');
  const id = requiredId(value.id, 'action id');
  if (!id.startsWith('action-')) throw new Error('Michael action id must start with action-.');
  if (!isActionKind(value.kind)) throw new Error('Michael action kind is not allowlisted.');
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw new Error('Michael action createdAt must be a timestamp.');
  }

  const action: OrchestratorActionRequest = {
    version: 1,
    id,
    kind: value.kind,
    createdAt: value.createdAt
  };
  if (value.inputId !== undefined) action.inputId = requiredId(value.inputId, 'input id');
  if (value.runId !== undefined) action.runId = requiredId(value.runId, 'run id');
  if (value.taskId !== undefined) action.taskId = requiredId(value.taskId, 'task id');

  if (value.kind === 'run.create') {
    if (typeof value.objective !== 'string' || !value.objective.trim() || value.objective.length > 32_768) {
      throw new Error('run.create requires a bounded objective.');
    }
    if (!STRATEGIES.includes(value.strategy as OrchestrationStrategy)) {
      throw new Error('run.create requires a valid strategy.');
    }
    if (!Array.isArray(value.providers) || value.providers.length < 1 || value.providers.length > 2
      || value.providers.some((provider) => !PROVIDERS.includes(provider as ProviderId))) {
      throw new Error('run.create requires one or two supported providers.');
    }
    if (!Number.isInteger(value.concurrency) || (value.concurrency as number) < 1 || (value.concurrency as number) > 4) {
      throw new Error('run.create concurrency must be between 1 and 4.');
    }
    action.objective = value.objective.trim();
    action.strategy = value.strategy as OrchestrationStrategy;
    action.providers = [...new Set(value.providers as ProviderId[])];
    action.concurrency = value.concurrency as number;
    if (value.profileIds !== undefined) {
      if (!Array.isArray(value.profileIds) || value.profileIds.length > 4) throw new Error('Invalid profile selection.');
      action.profileIds = value.profileIds.map((profile) => requiredId(profile, 'profile id'));
    }
    if (value.templateId !== undefined) action.templateId = requiredId(value.templateId, 'template id');
  } else if (value.kind.startsWith('run.')) {
    action.runId = requiredId(value.runId, 'run id');
    if (value.kind === 'run.verify' && value.provider !== undefined) {
      if (!PROVIDERS.includes(value.provider as ProviderId)) throw new Error('Invalid verification provider.');
      action.provider = value.provider as ProviderId;
    }
  } else {
    action.taskId = requiredId(value.taskId, 'task id');
    if (value.kind === 'task.review') {
      if (!['accepted', 'rejected'].includes(value.decision as string)) throw new Error('Invalid review decision.');
      action.decision = value.decision as 'accepted' | 'rejected';
    }
  }
  return action;
}

function requiredId(value: unknown, label: string): string {
  const id = safeId(value);
  if (!id) throw new Error(`Invalid ${label}.`);
  return id;
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value) ? value : null;
}

function isActionKind(value: unknown): value is OrchestratorActionKind {
  return typeof value === 'string' && ACTION_KINDS.includes(value as OrchestratorActionKind);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
