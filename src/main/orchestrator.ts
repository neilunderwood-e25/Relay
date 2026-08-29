import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  OperationResult,
  OrchestrationCreateRequest,
  OrchestrationReviewRequest,
  OrchestrationRunRequest,
  OrchestrationRun,
  OrchestrationSnapshot,
  OrchestrationStrategy,
  OrchestrationTask,
  OrchestrationTaskRequest,
  OrchestrationVerifyRequest,
  ProviderCapability,
  ProviderId,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalReplay,
  TerminalSnapshot,
  TaskDiffSnapshot,
  WorktreeCreateRequest,
  WorktreeSnapshot
} from '../shared/contracts';
import { DEFAULT_AGENT_NAMES, DEFAULT_ORCHESTRATOR_NAME } from '../shared/contracts';
import { personNameForSeed } from '../shared/agentIdentity';
import { planObjective } from '../shared/orchestration';
import type { RelayDatabase } from './database';

export { planObjective } from '../shared/orchestration';

const MAX_OBJECTIVE_LENGTH = 2_000;
const MAX_CONCURRENCY = 4;

interface WorktreeService {
  inspect(directory: string): Promise<{
    isRepository: boolean;
    mainRoot: string | null;
    currentBranch: string | null;
    branches: string[];
    error?: string;
  }>;
  create(request: WorktreeCreateRequest): Promise<WorktreeSnapshot>;
  diff(worktreeId: string, taskId: string): Promise<TaskDiffSnapshot>;
  integrate(worktreeId: string, commitMessage: string): Promise<{
    status: 'integrated' | 'no_changes' | 'conflict';
    commit?: string;
    conflicts?: string[];
    error?: string;
  }>;
  remove(request: { id: string; force?: boolean }): Promise<OperationResult>;
}

interface TerminalService {
  spawn(request: {
    provider: ProviderId;
    avatarSeed?: string;
    name?: string;
    cwd: string;
    cols?: number;
    rows?: number;
    args?: string[];
    role?: 'worker' | 'orchestrator';
  }): Promise<TerminalSnapshot>;
  stop(id: string, force?: boolean): OperationResult;
  replay(id: string): TerminalReplay;
}

export interface RehanOrchestratorOptions {
  database: RelayDatabase;
  logger: Logger;
  worktrees: WorktreeService;
  terminals: TerminalService;
  detectProviders: () => Promise<ProviderCapability[]>;
  getOrchestratorName?: () => string;
  onUpdate?: (snapshot: OrchestrationSnapshot) => void;
}

export class RehanOrchestrator {
  private readonly runTails = new Map<string, Promise<void>>();

  constructor(private readonly options: RehanOrchestratorOptions) {}

  recover(): number {
    const recovered = this.options.database.recoverInterruptedOrchestrations();
    if (recovered > 0) {
      this.options.logger.warn({ recovered }, 'Recovered interrupted orchestrator tasks');
    }
    return recovered;
  }

  list(repoRoot?: string): OrchestrationSnapshot[] {
    return this.options.database.listOrchestrations(repoRoot);
  }

  async create(request: OrchestrationCreateRequest): Promise<OrchestrationSnapshot> {
    const objective = request?.objective?.trim();
    if (!objective) throw new Error('Describe the coding objective first.');
    if (objective.length > MAX_OBJECTIVE_LENGTH) {
      throw new Error(`Keep the objective under ${MAX_OBJECTIVE_LENGTH.toLocaleString()} characters.`);
    }
    if (typeof request.repoPath !== 'string') throw new Error('Choose a Git repository first.');

    const repository = await this.options.worktrees.inspect(request.repoPath);
    if (!repository.isRepository || !repository.mainRoot) {
      throw new Error(repository.error ?? 'Choose a Git repository first.');
    }
    const baseBranch = request.baseBranch?.trim() || repository.currentBranch || repository.branches[0];
    if (!baseBranch || !repository.branches.includes(baseBranch)) {
      throw new Error('The repository needs a local base branch.');
    }

    const capabilities = await this.options.detectProviders();
    const available = new Set(capabilities.filter((provider) => provider.available).map((provider) => provider.id));
    const requested = request.providers?.length ? uniqueProviders(request.providers) : [...available];
    const providers = requested.filter((provider) => available.has(provider));
    if (providers.length === 0) throw new Error('No supported CLI workers are available.');

    const now = Date.now();
    const runId = `run-${randomUUID().slice(0, 12)}`;
    const strategy = validStrategy(request.strategy) ? request.strategy : 'balanced';
    const plans = planObjective(objective, providers, strategy);
    const run: OrchestrationRun = {
      id: runId,
      objective,
      repoRoot: repository.mainRoot,
      baseBranch,
      status: 'queued',
      strategy,
      concurrency: clampConcurrency(request.concurrency, providers.length),
      createdAt: now,
      updatedAt: now,
      integrationStatus: 'pending',
      verificationStatus: 'idle'
    };
    const tasks: OrchestrationTask[] = plans.map((plan, ordinal) => ({
      id: `task-${randomUUID().slice(0, 12)}`,
      runId,
      ordinal,
      title: plan.title,
      instructions: plan.instructions,
      role: plan.role,
      deliverable: plan.deliverable,
      provider: plan.provider,
      status: 'queued',
      attempt: 0,
      reviewStatus: 'pending',
      integrationStatus: 'pending',
      createdAt: now,
      updatedAt: now
    }));
    const snapshot = { run, tasks };

    this.options.database.createOrchestration(snapshot);
    this.options.database.appendEvent('orchestration.created', {
      runId,
      repoRoot: run.repoRoot,
      providers,
      strategy,
      taskCount: tasks.length
    });
    this.emit(runId);
    void this.pump(runId);
    return snapshot;
  }

  async stop(runId: string): Promise<OperationResult> {
    const snapshot = this.options.database.getOrchestration(runId);
    if (!snapshot) return { ok: false, error: 'Orchestrator run was not found.' };
    if (isFinalRun(snapshot.run.status)) return { ok: true };

    await this.enqueue(runId, async () => {
      const current = this.options.database.getOrchestration(runId);
      if (!current) return;
      const now = Date.now();
      current.run.status = 'stopping';
      current.run.updatedAt = now;
      for (const task of current.tasks) {
        if (task.status === 'queued') {
          task.status = 'stopped';
          task.updatedAt = now;
          task.completedAt = now;
          this.options.database.updateOrchestrationTask(task);
        } else if (task.status === 'starting' || task.status === 'running') {
          task.status = 'stopping';
          task.updatedAt = now;
          this.options.database.updateOrchestrationTask(task);
          if (task.terminalId) this.options.terminals.stop(task.terminalId);
        }
      }
      if (!current.tasks.some((task) => task.status === 'stopping')) {
        current.run.status = 'stopped';
        current.run.completedAt = now;
      }
      this.options.database.updateOrchestrationRun(current.run);
      this.options.database.appendEvent('orchestration.stopping', { runId });
      this.emit(runId);
    });
    return { ok: true };
  }

  async retry(request: OrchestrationTaskRequest): Promise<OperationResult> {
    const task = request && this.options.database.getOrchestrationTask(request.taskId);
    if (!task) return { ok: false, error: 'Orchestrator task was not found.' };
    if (!['blocked', 'failed', 'stopped'].includes(task.status)) {
      return { ok: false, error: 'Only blocked, failed, or stopped tasks can be retried.' };
    }

    await this.enqueue(task.runId, async () => {
      const currentTask = this.options.database.getOrchestrationTask(task.id);
      const current = this.options.database.getOrchestration(task.runId);
      if (!currentTask || !current) return;
      const now = Date.now();
      currentTask.status = 'queued';
      currentTask.terminalId = undefined;
      currentTask.error = undefined;
      currentTask.summary = undefined;
      currentTask.startedAt = undefined;
      currentTask.completedAt = undefined;
      currentTask.reviewStatus = 'pending';
      currentTask.integrationStatus = 'pending';
      currentTask.integrationCommit = undefined;
      currentTask.integrationError = undefined;
      currentTask.reviewedAt = undefined;
      currentTask.integratedAt = undefined;
      currentTask.updatedAt = now;
      current.run.status = 'queued';
      current.run.error = undefined;
      current.run.completedAt = undefined;
      current.run.integrationStatus = 'pending';
      current.run.integrationError = undefined;
      current.run.verificationStatus = 'idle';
      current.run.verificationProvider = undefined;
      current.run.verificationTerminalId = undefined;
      current.run.verificationSummary = undefined;
      current.run.verificationError = undefined;
      current.run.updatedAt = now;
      this.options.database.updateOrchestrationTask(currentTask);
      this.options.database.updateOrchestrationRun(current.run);
      this.options.database.appendEvent('orchestration.task.retried', { runId: task.runId, taskId: task.id });
      this.emit(task.runId);
    });
    void this.pump(task.runId);
    return { ok: true };
  }

  async diff(request: OrchestrationTaskRequest): Promise<TaskDiffSnapshot> {
    const task = request && this.options.database.getOrchestrationTask(request.taskId);
    if (!task?.worktreeId) throw new Error('This task does not have a worktree yet.');
    return this.options.worktrees.diff(task.worktreeId, task.id);
  }

  async review(request: OrchestrationReviewRequest): Promise<OrchestrationSnapshot> {
    const task = request && this.options.database.getOrchestrationTask(request.taskId);
    if (!task) throw new Error('Orchestrator task was not found.');
    if (!['accepted', 'rejected'].includes(request.decision)) throw new Error('Choose accept or reject.');
    if (task.status !== 'completed') throw new Error('Only completed tasks can be reviewed.');
    if (['integrated', 'no_changes'].includes(task.integrationStatus ?? 'pending')) {
      throw new Error('Integrated tasks cannot be reviewed again.');
    }

    await this.enqueue(task.runId, async () => {
      const currentTask = this.options.database.getOrchestrationTask(task.id);
      const current = this.options.database.getOrchestration(task.runId);
      if (!currentTask || !current) return;
      const now = Date.now();
      currentTask.reviewStatus = request.decision;
      currentTask.integrationStatus = 'pending';
      currentTask.integrationError = undefined;
      currentTask.reviewedAt = now;
      currentTask.updatedAt = now;
      current.run.integrationStatus = 'reviewing';
      current.run.integrationError = undefined;
      current.run.updatedAt = now;
      this.options.database.updateOrchestrationTask(currentTask);
      this.options.database.updateOrchestrationRun(current.run);
      this.options.database.appendEvent('orchestration.task.reviewed', {
        runId: task.runId,
        taskId: task.id,
        decision: request.decision
      });
      this.emit(task.runId);
    });
    return this.requireRun(task.runId);
  }

  async integrate(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot> {
    const runId = request?.runId;
    if (!runId) throw new Error('Orchestrator run was not found.');
    await this.enqueue(runId, async () => {
      const snapshot = this.requireRun(runId);
      if (snapshot.run.status !== 'completed') throw new Error('Finish the run before integrating results.');
      if (snapshot.tasks.some((task) => (task.reviewStatus ?? 'pending') === 'pending')) {
        throw new Error('Accept or reject every completed task first.');
      }
      const accepted = snapshot.tasks
        .filter((task) => task.reviewStatus === 'accepted')
        .sort((left, right) => left.ordinal - right.ordinal);
      if (accepted.length === 0) throw new Error('Accept at least one task before integrating.');

      const now = Date.now();
      snapshot.run.integrationStatus = 'integrating';
      snapshot.run.integrationError = undefined;
      snapshot.run.updatedAt = now;
      this.options.database.updateOrchestrationRun(snapshot.run);
      this.emit(runId);

      for (const task of accepted) {
        if (['integrated', 'no_changes'].includes(task.integrationStatus ?? 'pending')) continue;
        if (!task.worktreeId) {
          task.integrationStatus = 'failed';
          task.integrationError = 'The task worktree is missing.';
          this.options.database.updateOrchestrationTask(task);
          snapshot.run.integrationStatus = 'failed';
          snapshot.run.integrationError = task.integrationError;
          this.options.database.updateOrchestrationRun(snapshot.run);
          this.emit(runId);
          return;
        }
        task.integrationStatus = 'integrating';
        task.integrationError = undefined;
        task.updatedAt = Date.now();
        this.options.database.updateOrchestrationTask(task);
        this.emit(runId);
        try {
          const result = await this.options.worktrees.integrate(task.worktreeId, `Relay: ${task.title}`.slice(0, 120));
          task.integrationStatus = result.status;
          task.integrationCommit = result.commit;
          task.integrationError = result.error;
          task.integratedAt = result.status === 'conflict' ? undefined : Date.now();
          task.updatedAt = Date.now();
          this.options.database.updateOrchestrationTask(task);
          if (result.status === 'conflict') {
            snapshot.run.integrationStatus = 'conflict';
            snapshot.run.integrationError = result.error ?? 'Integration conflict.';
            snapshot.run.updatedAt = Date.now();
            this.options.database.updateOrchestrationRun(snapshot.run);
            this.options.database.appendEvent('orchestration.integration.conflict', {
              runId,
              taskId: task.id,
              conflicts: result.conflicts ?? []
            });
            this.emit(runId);
            return;
          }
          this.options.database.appendEvent('orchestration.task.integrated', {
            runId,
            taskId: task.id,
            status: result.status,
            commit: result.commit
          });
        } catch (error) {
          task.integrationStatus = 'failed';
          task.integrationError = messageOf(error);
          task.updatedAt = Date.now();
          this.options.database.updateOrchestrationTask(task);
          snapshot.run.integrationStatus = 'failed';
          snapshot.run.integrationError = task.integrationError;
          snapshot.run.updatedAt = Date.now();
          this.options.database.updateOrchestrationRun(snapshot.run);
          this.emit(runId);
          return;
        }
      }

      snapshot.run.integrationStatus = 'integrated';
      snapshot.run.integrationError = undefined;
      snapshot.run.verificationStatus = 'idle';
      snapshot.run.updatedAt = Date.now();
      this.options.database.updateOrchestrationRun(snapshot.run);
      this.options.database.appendEvent('orchestration.integrated', { runId });
      this.emit(runId);
    });
    return this.requireRun(runId);
  }

  async verify(request: OrchestrationVerifyRequest): Promise<OrchestrationSnapshot> {
    const runId = request?.runId;
    if (!runId) throw new Error('Orchestrator run was not found.');
    await this.enqueue(runId, async () => {
      const snapshot = this.requireRun(runId);
      if (snapshot.run.integrationStatus !== 'integrated') throw new Error('Integrate accepted work first.');
      if (snapshot.run.verificationStatus === 'running') throw new Error('Verification is already running.');
      const capabilities = await this.options.detectProviders();
      const requested = request.provider;
      const provider = capabilities.find((candidate) => candidate.available && candidate.id === requested)
        ?? capabilities.find((candidate) => candidate.available);
      if (!provider) throw new Error('No supported CLI verifier is available.');

      const prompt = verificationPrompt(snapshot.run, this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME);
      const terminal = await this.options.terminals.spawn({
        provider: provider.id,
        avatarSeed: `${runId}-verification`,
        name: 'Verifier',
        cwd: snapshot.run.repoRoot,
        cols: 120,
        rows: 32,
        args: verificationArgs(provider.id, prompt)
      });
      snapshot.run.verificationStatus = 'running';
      snapshot.run.verificationProvider = provider.id;
      snapshot.run.verificationTerminalId = terminal.id;
      snapshot.run.verificationSummary = undefined;
      snapshot.run.verificationError = undefined;
      snapshot.run.updatedAt = Date.now();
      this.options.database.updateOrchestrationRun(snapshot.run);
      this.options.database.appendEvent('orchestration.verification.started', {
        runId,
        provider: provider.id,
        terminalId: terminal.id
      });
      this.emit(runId);
    });
    return this.requireRun(runId);
  }

  async cleanup(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot> {
    const runId = request?.runId;
    if (!runId) throw new Error('Orchestrator run was not found.');
    await this.enqueue(runId, async () => {
      const snapshot = this.requireRun(runId);
      if (snapshot.run.integrationStatus !== 'integrated') throw new Error('Integrate accepted work before cleanup.');
      if (!['passed', 'failed'].includes(snapshot.run.verificationStatus ?? 'idle')) {
        throw new Error('Run final verification before cleanup.');
      }
      const failures: string[] = [];
      for (const task of snapshot.tasks) {
        if (!task.worktreeId) continue;
        const result = await this.options.worktrees.remove({ id: task.worktreeId, force: true });
        if (!result.ok) failures.push(result.error ?? task.title);
        else {
          task.worktreeId = undefined;
          task.worktreePath = undefined;
          task.updatedAt = Date.now();
          this.options.database.updateOrchestrationTask(task);
        }
      }
      if (failures.length > 0) throw new Error(failures.join(' '));
      this.options.database.appendEvent('orchestration.cleaned', { runId });
      this.emit(runId);
    });
    return this.requireRun(runId);
  }

  handleTerminalData(event: TerminalDataEvent): void {
    const task = this.options.database.getOrchestrationTaskByTerminal(event.id);
    if (!task || task.status !== 'starting') return;
    void this.enqueue(task.runId, async () => {
      const current = this.options.database.getOrchestrationTask(task.id);
      if (!current || current.status !== 'starting') return;
      current.status = 'running';
      current.updatedAt = Date.now();
      this.options.database.updateOrchestrationTask(current);
      this.emit(current.runId);
    });
  }

  handleTerminalExit(event: TerminalExitEvent): void {
    const task = this.options.database.getOrchestrationTaskByTerminal(event.id);
    if (!task) {
      const verification = this.options.database.getOrchestrationByVerificationTerminal(event.id);
      if (!verification) return;
      void this.enqueue(verification.run.id, async () => {
        const current = this.options.database.getOrchestration(verification.run.id);
        if (!current || current.run.verificationStatus !== 'running') return;
        current.run.verificationStatus = event.exitCode === 0 ? 'passed' : 'failed';
        current.run.verificationSummary = summaryFromReplay(this.safeReplay(event.id));
        current.run.verificationError = event.exitCode === 0
          ? undefined
          : `Verifier exited with code ${event.exitCode}.`;
        current.run.updatedAt = event.exitedAt;
        this.options.database.updateOrchestrationRun(current.run);
        this.options.database.appendEvent('orchestration.verification.finished', {
          runId: current.run.id,
          status: current.run.verificationStatus,
          exitCode: event.exitCode
        });
        this.emit(current.run.id);
      });
      return;
    }
    void this.enqueue(task.runId, async () => {
      const current = this.options.database.getOrchestrationTask(task.id);
      const run = this.options.database.getOrchestration(task.runId)?.run;
      if (!current || !run || isFinalTask(current.status)) return;
      const stopped = current.status === 'stopping' || run.status === 'stopping' || run.status === 'stopped';
      current.status = stopped ? 'stopped' : event.exitCode === 0 ? 'completed' : 'failed';
      current.summary = summaryFromReplay(this.safeReplay(event.id));
      current.error = current.status === 'failed' ? `Worker exited with code ${event.exitCode}.` : undefined;
      current.updatedAt = event.exitedAt;
      current.completedAt = event.exitedAt;
      this.options.database.updateOrchestrationTask(current);
      this.options.database.appendEvent('orchestration.task.finished', {
        runId: current.runId,
        taskId: current.id,
        status: current.status,
        exitCode: event.exitCode
      });
      this.reconcileRun(current.runId);
      this.emit(current.runId);
    }).then(() => this.pump(task.runId));
  }

  private pump(runId: string): Promise<void> {
    return this.enqueue(runId, async () => {
      const snapshot = this.options.database.getOrchestration(runId);
      if (!snapshot || isFinalRun(snapshot.run.status) || snapshot.run.status === 'stopping') return;
      const active = snapshot.tasks.filter((task) => ['starting', 'running', 'stopping'].includes(task.status)).length;
      const slots = Math.max(0, snapshot.run.concurrency - active);
      const queued = snapshot.tasks.filter((task) => task.status === 'queued').slice(0, slots);
      if (queued.length === 0) {
        this.reconcileRun(runId);
        this.emit(runId);
        return;
      }

      const now = Date.now();
      snapshot.run.status = 'running';
      snapshot.run.startedAt ??= now;
      snapshot.run.updatedAt = now;
      this.options.database.updateOrchestrationRun(snapshot.run);
      for (const task of queued) {
        task.status = 'starting';
        task.attempt += 1;
        task.startedAt = now;
        task.completedAt = undefined;
        task.updatedAt = now;
        this.options.database.updateOrchestrationTask(task);
      }
      this.emit(runId);
      await Promise.all(queued.map((task) => this.startTask(snapshot.run, task)));
      this.reconcileRun(runId);
      this.emit(runId);
    });
  }

  private async startTask(run: OrchestrationRun, task: OrchestrationTask): Promise<void> {
    try {
      if (!task.worktreePath) {
        const worktree = await this.options.worktrees.create({
          repoPath: run.repoRoot,
          name: worktreeName(run.id, task),
          baseBranch: run.baseBranch
        });
        task.worktreeId = worktree.id;
        task.worktreePath = worktree.path;
        task.branch = worktree.branch;
        task.updatedAt = Date.now();
        this.options.database.updateOrchestrationTask(task);
        this.emit(run.id);
      }

      const prompt = workerPrompt(run, task, this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME);
      const terminal = await this.options.terminals.spawn({
        provider: task.provider,
        avatarSeed: task.id,
        cwd: task.worktreePath,
        name: personNameForSeed(task.id),
        cols: 120,
        rows: 32,
        args: workerArgs(task.provider, prompt)
      });
      task.terminalId = terminal.id;
      task.status = 'running';
      task.error = undefined;
      task.updatedAt = Date.now();
      this.options.database.updateOrchestrationTask(task);
      this.options.database.appendEvent('orchestration.task.started', {
        runId: run.id,
        taskId: task.id,
        provider: task.provider,
        terminalId: terminal.id,
        worktreeId: task.worktreeId
      });
      this.options.logger.info(
        { runId: run.id, taskId: task.id, provider: task.provider, terminalId: terminal.id },
        'Orchestrator worker started'
      );
    } catch (error) {
      task.status = 'failed';
      task.error = messageOf(error);
      task.updatedAt = Date.now();
      task.completedAt = task.updatedAt;
      this.options.database.updateOrchestrationTask(task);
      this.options.database.appendEvent('orchestration.task.failed', {
        runId: run.id,
        taskId: task.id,
        error: task.error
      });
      this.options.logger.error({ runId: run.id, taskId: task.id, error }, 'Orchestrator worker failed to start');
    }
  }

  private reconcileRun(runId: string): void {
    const snapshot = this.options.database.getOrchestration(runId);
    if (!snapshot) return;
    const now = Date.now();
    const statuses = new Set(snapshot.tasks.map((task) => task.status));
    if (snapshot.run.status === 'stopping') {
      if (![...statuses].some((status) => ['starting', 'running', 'stopping'].includes(status))) {
        snapshot.run.status = 'stopped';
        snapshot.run.completedAt = now;
      }
    } else if (snapshot.tasks.every((task) => task.status === 'completed')) {
      snapshot.run.status = 'completed';
      snapshot.run.completedAt = now;
      snapshot.run.error = undefined;
    } else if (statuses.has('queued') || statuses.has('starting') || statuses.has('running')) {
      snapshot.run.status = 'running';
    } else if (statuses.has('blocked')) {
      snapshot.run.status = 'blocked';
      snapshot.run.completedAt = now;
      snapshot.run.error = 'One or more tasks need attention.';
    } else if (statuses.has('failed')) {
      snapshot.run.status = 'failed';
      snapshot.run.completedAt = now;
      snapshot.run.error = 'One or more tasks failed.';
    } else if (snapshot.tasks.every((task) => task.status === 'stopped')) {
      snapshot.run.status = 'stopped';
      snapshot.run.completedAt = now;
    }
    snapshot.run.updatedAt = now;
    this.options.database.updateOrchestrationRun(snapshot.run);
  }

  private safeReplay(terminalId: string): TerminalReplay {
    try {
      return this.options.terminals.replay(terminalId);
    } catch {
      return { data: '', lastSequence: 0 };
    }
  }

  private emit(runId: string): void {
    const snapshot = this.options.database.getOrchestration(runId);
    if (snapshot) this.options.onUpdate?.(snapshot);
  }

  private requireRun(runId: string): OrchestrationSnapshot {
    const snapshot = this.options.database.getOrchestration(runId);
    if (!snapshot) throw new Error('Orchestrator run was not found.');
    return snapshot;
  }

  private enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.runTails.get(runId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    this.runTails.set(runId, settled);
    void settled.finally(() => {
      if (this.runTails.get(runId) === settled) this.runTails.delete(runId);
    });
    return next;
  }
}

function workerPrompt(run: OrchestrationRun, task: OrchestrationTask, orchestratorName: string): string {
  return [
    `You are ${personNameForSeed(task.id)}, a Relay worker coordinated by ${orchestratorName}.`,
    `Provider: ${DEFAULT_AGENT_NAMES[task.provider]}.`,
    `Objective: ${run.objective}`,
    `Role: ${task.role}`,
    `Your task: ${task.instructions}`,
    `Expected deliverable: ${task.deliverable}`,
    `Branch: ${task.branch ?? '(preparing)'}`,
    'Work only inside the current worktree. Do not modify other checkouts or merge branches.',
    'Do not commit unless the objective explicitly asks for a commit.',
    'Inspect existing code first, implement the task, run proportionate checks, then give a concise final summary.'
  ].join('\n\n').slice(0, 4_000);
}

function workerArgs(provider: ProviderId, prompt: string): string[] {
  return provider === 'claude'
    ? ['--print', '--permission-mode', 'acceptEdits', '--output-format', 'text', '--no-session-persistence', prompt]
    : ['--ask-for-approval', 'never', 'exec', '--sandbox', 'workspace-write', '--color', 'always', '--ephemeral', prompt];
}

function verificationPrompt(run: OrchestrationRun, orchestratorName: string): string {
  return [
    `You are the final verifier for ${orchestratorName} in Relay.`,
    `Objective: ${run.objective}`,
    `Integrated branch: ${run.baseBranch}`,
    'Inspect the integrated changes, run the most relevant existing checks, and report defects with file references.',
    'This is read-only verification. Do not edit files, create commits, or change Git state.',
    'End with a concise verdict and list the checks you ran.'
  ].join('\n\n').slice(0, 4_000);
}

function verificationArgs(provider: ProviderId, prompt: string): string[] {
  return provider === 'claude'
    ? ['--print', '--permission-mode', 'plan', '--output-format', 'text', '--no-session-persistence', prompt]
    : ['--ask-for-approval', 'never', 'exec', '--sandbox', 'read-only', '--color', 'always', '--ephemeral', prompt];
}

function worktreeName(runId: string, task: OrchestrationTask): string {
  const runPart = runId.replace(/^run-/, '').slice(0, 6);
  return `orchestrator-${runPart}-${task.ordinal + 1}-${task.provider}`.slice(0, 48);
}

function clampConcurrency(value: number | undefined, providerCount: number): number {
  if (!Number.isFinite(value)) return Math.max(1, Math.min(MAX_CONCURRENCY, providerCount));
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(value!)));
}

function validStrategy(value: unknown): value is OrchestrationStrategy {
  return ['balanced', 'parallel', 'audit'].includes(value as OrchestrationStrategy);
}

function uniqueProviders(providers: ProviderId[]): ProviderId[] {
  return [...new Set(providers.filter((provider): provider is ProviderId => ['claude', 'codex'].includes(provider)))];
}

function summaryFromReplay(replay: TerminalReplay): string | undefined {
  const plain = replay.data
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '')
    .trim();
  return plain ? plain.slice(-4_000) : undefined;
}

function isFinalTask(status: OrchestrationTask['status']): boolean {
  return ['blocked', 'failed', 'completed', 'stopped'].includes(status);
}

function isFinalRun(status: OrchestrationRun['status']): boolean {
  return ['blocked', 'failed', 'completed', 'stopped'].includes(status);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
