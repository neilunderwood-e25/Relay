import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import type {
  AgentSession,
  AgentSessionInputRequest,
  AgentSessionRequest,
  AgentProfile,
  HiveCoordinationMessage,
  OperationResult,
  OrchestrationCreateRequest,
  OrchestrationReplanRequest,
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
  TerminalOutputMode,
  TerminalReplay,
  TerminalRole,
  TerminalSnapshot,
  TaskDiffSnapshot,
  WorktreeCreateRequest,
  WorktreeSnapshot
} from '../shared/contracts';
import { DEFAULT_AGENT_NAMES, DEFAULT_ORCHESTRATOR_NAME, PROVIDER_IDS } from '../shared/contracts';
import { personNameForSeed } from '../shared/agentIdentity';
import { intelligentPlanningPrompt, parseIntelligentPlan } from '../shared/intelligentPlan';
import {
  fallbackSynthesis,
  intelligentSynthesisPrompt,
  parseIntelligentSynthesis
} from '../shared/intelligentSynthesis';
import {
  planObjective,
  planObjectiveForAgents,
  recommendedVerificationAssignment
} from '../shared/orchestration';
import type { PlannedTask } from '../shared/orchestration';
import { extractProviderResult } from '../shared/providerOutput';
import type { RelayDatabase } from './database';
import { providerAdapter } from './providerAdapters';
import { isProviderReady } from './providers';

export { planObjective } from '../shared/orchestration';

const MAX_OBJECTIVE_LENGTH = 2_000;
const MAX_CONCURRENCY = 4;
const PLANNING_TIMEOUT_MS = 5 * 60_000;
const SYNTHESIS_TIMEOUT_MS = 5 * 60_000;
const VERIFICATION_TIMEOUT_MS = 15 * 60_000;
const WORKER_TIMEOUT_MS = 45 * 60_000;
const MAX_WORKER_SIGNAL_BUFFER = 512 * 1024;
const MAX_AGENT_FOLLOWUP_LENGTH = 16_000;

interface InteractiveWorkerSignal {
  kind: 'task' | 'followup';
  taskId: string;
  sessionId?: string;
  completionMarker: string;
  blockedMarker: string;
  transcript: string;
  settling: boolean;
  baselineDiff?: string;
  baselineDiffError?: string;
  baselineTaskStatus?: OrchestrationTask['status'];
  exit?: { exitCode: number; exitedAt: number; timeoutReason?: string };
  stopRequested?: boolean;
}

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
    role?: TerminalRole;
    outputMode?: TerminalOutputMode;
  }): Promise<TerminalSnapshot>;
  submit(id: string, text: string): Promise<OperationResult>;
  stop(id: string, force?: boolean): OperationResult;
  replay(id: string): TerminalReplay;
}

export interface OrchestratorOptions {
  database: RelayDatabase;
  logger: Logger;
  worktrees: WorktreeService;
  terminals: TerminalService;
  detectProviders: () => Promise<ProviderCapability[]>;
  getOrchestratorName?: () => string;
  getOrchestratorConfig?: () => { provider: ProviderId; model: string | null };
  onCoordinationMessage?: (message: HiveCoordinationMessage) => void;
  phaseTimeouts?: Partial<Record<'planning' | 'worker' | 'synthesis' | 'verification', number>>;
  prepareWorkerTerminal?: (terminal: TerminalSnapshot, worktreePath: string) => Promise<TerminalSnapshot>;
  resolveWorkerSessionId?: (
    provider: ProviderId,
    cwd: string,
    startedAt: number
  ) => Promise<string | undefined>;
  createWorkerSessionId?: (
    provider: ProviderId,
    cwd: string
  ) => Promise<string | undefined>;
  readWorkerResult?: (
    provider: ProviderId,
    cwd: string,
    nativeSessionId: string,
    startedAt: number,
    requiredMarker: string
  ) => Promise<string | undefined>;
  onUpdate?: (snapshot: OrchestrationSnapshot) => void;
}

export class Orchestrator {
  private readonly runTails = new Map<string, Promise<void>>();
  private readonly terminalTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly timeoutReasons = new Map<string, string>();
  private readonly workerSignals = new Map<string, InteractiveWorkerSignal>();
  private readonly nativeSessionLookups = new Set<string>();

  constructor(private readonly options: OrchestratorOptions) {}

  recover(): number {
    const recovered = this.options.database.recoverInterruptedOrchestrations();
    if (recovered > 0) {
      this.options.logger.warn({ recovered }, 'Recovered interrupted orchestrator tasks');
    }
    return recovered;
  }

  shutdown(): void {
    for (const timer of this.terminalTimeouts.values()) clearTimeout(timer);
    this.terminalTimeouts.clear();
    this.timeoutReasons.clear();
    this.workerSignals.clear();
    this.nativeSessionLookups.clear();
  }

  list(repoRoot?: string): OrchestrationSnapshot[] {
    return this.options.database.listOrchestrations(repoRoot);
  }

  listAgentSessions(repoRoot?: string): AgentSession[] {
    const runIds = new Set(this.options.database.listOrchestrations(repoRoot).map(({ run }) => run.id));
    return this.options.database.listAgentSessions()
      .filter((session) => runIds.has(session.runId))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  canRemoveWorktree(worktreeId: string): OperationResult {
    const active = this.options.database.listAgentSessions()
      .find((session) => session.worktreeId === worktreeId
        && ['starting', 'working', 'idle', 'stopping'].includes(session.status));
    return active
      ? { ok: false, error: `Stop ${active.agentName} before deleting this worktree.` }
      : { ok: true };
  }

  async finalizeWorktreeRemoval(worktreeId: string): Promise<void> {
    const sessions = this.options.database.listAgentSessions()
      .filter((session) => session.worktreeId === worktreeId && session.status !== 'closed');
    const runIds = [...new Set(sessions.map((session) => session.runId))];
    for (const runId of runIds) {
      await this.enqueue(runId, async () => {
        for (const candidate of sessions.filter((session) => session.runId === runId)) {
          const session = this.options.database.getAgentSession(candidate.id);
          if (!session || session.worktreeId !== worktreeId) continue;
          const task = this.options.database.getOrchestrationTask(session.initialTaskId);
          if (task) {
            task.worktreeId = undefined;
            task.worktreePath = undefined;
            task.terminalId = undefined;
            task.updatedAt = Date.now();
            this.options.database.updateOrchestrationTask(task);
          }
          this.closeAgentSession(session, 'This agent worktree was removed.');
        }
        this.emit(runId);
      });
    }
  }

  reconcileRecoveredSessions(): number {
    let changed = 0;
    for (const session of this.options.database.listAgentSessions()) {
      if (!['resumable', 'stopped'].includes(session.status) || !session.worktreePath) continue;
      if (existsSync(session.worktreePath)) continue;
      session.status = 'failed';
      session.terminalId = undefined;
      session.updatedAt = Date.now();
      session.stoppedAt = session.updatedAt;
      session.error = 'The agent worktree is missing. Restore it before resuming this session.';
      this.options.database.upsertAgentSession(session);
      this.options.database.appendEvent('orchestration.agent_session.recovery_failed', {
        sessionId: session.id,
        runId: session.runId,
        reason: 'missing_worktree'
      });
      this.emit(session.runId);
      changed += 1;
    }
    return changed;
  }

  async submitAgentSessionInput(request: AgentSessionInputRequest): Promise<AgentSession> {
    const prompt = request?.prompt?.trim();
    if (!prompt) throw new Error('Enter a follow-up first.');
    if (prompt.length > MAX_AGENT_FOLLOWUP_LENGTH) {
      throw new Error(`Keep follow-ups under ${MAX_AGENT_FOLLOWUP_LENGTH.toLocaleString()} characters.`);
    }
    const existing = request?.sessionId
      ? this.options.database.getAgentSession(request.sessionId)
      : undefined;
    if (!existing) throw new Error('The agent session was not found.');

    await this.enqueue(existing.runId, async () => {
      const session = this.options.database.getAgentSession(existing.id);
      if (!session) throw new Error('The agent session was not found.');
      if (session.status !== 'idle' || !session.terminalId) {
        throw new Error(session.status === 'working'
          ? `${session.agentName} is still working.`
          : `Restart ${session.agentName} before sending a follow-up.`);
      }
      if (this.workerSignals.has(session.terminalId)) {
        throw new Error(`${session.agentName} is still working.`);
      }

      const checkpoint = await this.captureTaskDiff(session.initialTaskId);
      const task = this.options.database.getOrchestrationTask(session.initialTaskId);
      const completionToken = randomUUID().replace(/-/g, '').slice(0, 20);
      const terminalId = session.terminalId;
      this.workerSignals.set(terminalId, {
        kind: 'followup',
        taskId: session.initialTaskId,
        sessionId: session.id,
        completionMarker: `RELAY_AGENT_READY:${completionToken}`,
        blockedMarker: `RELAY_AGENT_BLOCKED:${completionToken}:`,
        transcript: '',
        settling: false,
        baselineDiff: checkpoint.fingerprint,
        baselineDiffError: checkpoint.error,
        baselineTaskStatus: task?.status
      });
      session.status = 'working';
      session.updatedAt = Date.now();
      session.lastActiveAt = session.updatedAt;
      session.error = undefined;
      this.options.database.upsertAgentSession(session);
      this.emit(session.runId);

      const result = await this.options.terminals.submit(
        terminalId,
        agentFollowupPrompt(prompt, completionToken)
      );
      if (!result.ok) {
        this.workerSignals.delete(terminalId);
        session.status = 'idle';
        session.updatedAt = Date.now();
        session.error = result.error ?? 'Could not submit the follow-up.';
        this.options.database.upsertAgentSession(session);
        this.emit(session.runId);
        throw new Error(session.error);
      }
      this.armTerminalTimeout(
        terminalId,
        this.phaseTimeout('worker', WORKER_TIMEOUT_MS),
        'Agent follow-up timed out after 45 minutes.'
      );
      this.options.database.appendEvent('orchestration.agent_session.prompted', {
        sessionId: session.id,
        runId: session.runId,
        terminalId,
        promptLength: prompt.length,
        worktreeCheckpoint: checkpoint.fingerprint ? 'captured' : 'unavailable',
        worktreeCheckpointError: checkpoint.error
      });
    });
    return this.options.database.getAgentSession(existing.id)!;
  }

  async restartAgentSession(request: AgentSessionRequest): Promise<AgentSession> {
    const existing = request?.sessionId
      ? this.options.database.getAgentSession(request.sessionId)
      : undefined;
    if (!existing) throw new Error('The agent session was not found.');

    await this.enqueue(existing.runId, async () => {
      const session = this.options.database.getAgentSession(existing.id);
      if (!session) throw new Error('The agent session was not found.');
      if (['starting', 'working', 'idle', 'stopping'].includes(session.status)) {
        throw new Error(`${session.agentName} already has a live session.`);
      }
      if (session.status === 'closed') {
        throw new Error(`${session.agentName}'s worktree was removed. This session cannot be restarted.`);
      }
      if (!session.worktreePath || !existsSync(session.worktreePath)) {
        session.status = 'failed';
        session.updatedAt = Date.now();
        session.stoppedAt = session.updatedAt;
        session.error = 'The agent worktree is missing. Restore it before resuming this session.';
        this.options.database.upsertAgentSession(session);
        this.emit(session.runId);
        throw new Error(session.error);
      }
      session.status = 'starting';
      session.updatedAt = Date.now();
      session.error = undefined;
      this.options.database.upsertAgentSession(session);
      this.emit(session.runId);

      try {
        if (session.provider === 'cursor' && !session.nativeSessionId && this.options.resolveWorkerSessionId) {
          session.nativeSessionId = await this.options.resolveWorkerSessionId(
            session.provider,
            session.worktreePath,
            session.startedAt ?? session.createdAt
          );
          if (!session.nativeSessionId) {
            throw new Error('Cursor conversation identity could not be recovered. Start a new task instead.');
          }
          session.updatedAt = Date.now();
          this.options.database.upsertAgentSession(session);
        }
        const spawned = await this.options.terminals.spawn({
          provider: session.provider,
          outputMode: 'terminal',
          avatarSeed: session.avatarSeed,
          cwd: session.worktreePath,
          name: session.agentName,
          cols: 120,
          rows: 32,
          args: providerAdapter(session.provider).resumeWorkerArgs(session.model, session.nativeSessionId)
        });
        const terminal = this.options.prepareWorkerTerminal
          ? await this.options.prepareWorkerTerminal(spawned, session.worktreePath)
          : spawned;
        const task = this.options.database.getOrchestrationTask(session.initialTaskId);
        if (task) {
          task.terminalId = terminal.id;
          task.updatedAt = Date.now();
          this.options.database.updateOrchestrationTask(task);
        }
        session.terminalId = terminal.id;
        session.status = 'idle';
        session.updatedAt = Date.now();
        session.lastActiveAt = session.updatedAt;
        session.stoppedAt = undefined;
        this.options.database.upsertAgentSession(session);
        this.options.database.appendEvent('orchestration.agent_session.restarted', {
          sessionId: session.id,
          runId: session.runId,
          terminalId: terminal.id,
          provider: session.provider,
          nativeSessionId: session.nativeSessionId ?? null
        });
        this.emit(session.runId);
      } catch (error) {
        session.status = 'failed';
        session.updatedAt = Date.now();
        session.stoppedAt = session.updatedAt;
        session.error = messageOf(error);
        this.options.database.upsertAgentSession(session);
        this.emit(session.runId);
        throw error;
      }
    });
    return this.options.database.getAgentSession(existing.id)!;
  }

  async stopAgentSession(request: AgentSessionRequest): Promise<OperationResult> {
    const existing = request?.sessionId
      ? this.options.database.getAgentSession(request.sessionId)
      : undefined;
    if (!existing) return { ok: false, error: 'The agent session was not found.' };
    let result: OperationResult = { ok: true };
    await this.enqueue(existing.runId, async () => {
      const session = this.options.database.getAgentSession(existing.id);
      if (!session || !session.terminalId || ['stopped', 'resumable', 'failed', 'closed'].includes(session.status)) return;
      const signal = this.workerSignals.get(session.terminalId);
      if (signal?.kind === 'followup') signal.stopRequested = true;
      result = this.options.terminals.stop(session.terminalId);
      if (!result.ok) {
        if (signal?.kind === 'followup') signal.stopRequested = false;
        return;
      }
      this.clearTerminalTimeout(session.terminalId);
      if (signal?.kind !== 'followup') this.workerSignals.delete(session.terminalId);
      const task = this.options.database.getOrchestrationTask(session.initialTaskId);
      if (task && ['starting', 'running'].includes(task.status)) {
        task.status = 'stopping';
        task.updatedAt = Date.now();
        this.options.database.updateOrchestrationTask(task);
      }
      session.status = 'stopping';
      session.updatedAt = Date.now();
      session.stoppedAt = undefined;
      this.options.database.upsertAgentSession(session);
      this.options.database.appendEvent('orchestration.agent_session.stop_requested', {
        sessionId: session.id,
        runId: session.runId,
        terminalId: session.terminalId
      });
      this.emit(session.runId);
    });
    return result;
  }

  async create(
    request: OrchestrationCreateRequest,
    replan?: { parentRunId: string; context: string }
  ): Promise<OrchestrationSnapshot> {
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
    const available = new Set(capabilities.filter(isProviderReady).map((provider) => provider.id));
    const template = request.templateId
      ? this.options.database.getOrchestrationTemplate(request.templateId)
      : undefined;
    if (request.templateId && !template) throw new Error('The orchestration template was not found.');
    const profileIds = request.profileIds?.length ? request.profileIds : template?.profileIds ?? [];
    const profiles = resolveProfiles(this.options.database, profileIds, available);
    const requested = request.providers?.length ? uniqueProviders(request.providers) : [...available];
    const providers = profiles.length > 0
      ? profiles.map((profile) => profile.provider)
      : requested.filter((provider) => available.has(provider));
    if (providers.length === 0) throw new Error('No supported CLI workers are available.');

    const now = Date.now();
    const runId = `run-${randomUUID().slice(0, 12)}`;
    const strategy = validStrategy(request.strategy) ? request.strategy : template?.strategy ?? 'balanced';
    const fallbackPlans = profiles.length > 0
      ? planObjectiveForAgents(objective, profiles.map((profile) => ({
          provider: profile.provider,
          profileId: profile.id,
          name: profile.name,
          avatarSeed: profile.avatarSeed,
          model: profile.model,
          instructions: profile.instructions
        })), strategy)
      : planObjective(objective, providers, strategy);
    const run: OrchestrationRun = {
      id: runId,
      objective,
      repoRoot: repository.mainRoot,
      baseBranch,
      status: 'planning',
      strategy,
      concurrency: clampConcurrency(request.concurrency ?? template?.concurrency, fallbackPlans.length),
      createdAt: now,
      updatedAt: now,
      integrationStatus: 'pending',
      verificationStatus: 'idle',
      templateId: template?.id,
      planningProviders: uniqueProviders(providers).sort(),
      planningProfileIds: profiles.map((profile) => profile.id),
      parentRunId: replan?.parentRunId,
      replanContext: replan?.context,
      synthesisStatus: 'idle'
    };
    const tasks: OrchestrationTask[] = [];
    const snapshot = { run, tasks };

    this.options.database.createOrchestration(snapshot);
    this.options.database.appendEvent('orchestration.created', {
      runId,
      repoRoot: run.repoRoot,
      providers,
      profileIds: profiles.map((profile) => profile.id),
      templateId: template?.id,
      strategy,
      taskCount: tasks.length,
      planning: true
    });
    this.emit(runId);
    await this.startPlanning(run, fallbackPlans);
    return this.requireRun(runId);
  }

  async replan(request: OrchestrationReplanRequest): Promise<OrchestrationSnapshot> {
    const source = request?.runId && this.options.database.getOrchestration(request.runId);
    if (!source) throw new Error('Orchestrator run was not found.');
    const recoverable = ['blocked', 'failed', 'stopped'].includes(source.run.status)
      || source.run.integrationStatus === 'conflict'
      || source.run.integrationStatus === 'failed'
      || source.run.verificationStatus === 'failed';
    if (!recoverable) {
      throw new Error('Only blocked, failed, stopped, conflicted, or verification-failed runs can be re-planned.');
    }
    const profileIds = [...new Set(source.tasks.flatMap((task) => task.profileId ? [task.profileId] : []))];
    const providers = [...new Set(source.tasks.map((task) => task.provider))];
    const context = replanContext(source);
    this.message(source.run.id, undefined, 'replan', this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME, context);
    const created = await this.create({
      repoPath: source.run.repoRoot,
      objective: source.run.objective,
      strategy: source.run.strategy,
      baseBranch: source.run.baseBranch,
      providers: (source.run.planningProviders?.length ?? 0) > 0 ? source.run.planningProviders : providers,
      profileIds: (source.run.planningProfileIds?.length ?? 0) > 0 ? source.run.planningProfileIds : profileIds,
      concurrency: source.run.concurrency,
      templateId: source.run.templateId
    }, { parentRunId: source.run.id, context });
    this.options.database.appendEvent('orchestration.replanned', {
      sourceRunId: source.run.id,
      replacementRunId: created.run.id
    });
    return created;
  }

  async stop(runId: string): Promise<OperationResult> {
    const snapshot = this.options.database.getOrchestration(runId);
    if (!snapshot) return { ok: false, error: 'Orchestrator run was not found.' };
    if (isFinalRun(snapshot.run.status)) {
      if (snapshot.run.verificationStatus !== 'running' || !snapshot.run.verificationTerminalId) return { ok: true };
      await this.enqueue(runId, async () => {
        const current = this.options.database.getOrchestration(runId);
        if (!current || current.run.verificationStatus !== 'running' || !current.run.verificationTerminalId) return;
        const terminalId = current.run.verificationTerminalId;
        this.clearTerminalTimeout(terminalId);
        this.options.terminals.stop(terminalId);
        current.run.verificationStatus = 'failed';
        current.run.verificationError = 'Verification stopped by user.';
        current.run.updatedAt = Date.now();
        this.options.database.updateOrchestrationRun(current.run);
        this.options.database.appendEvent('orchestration.verification.finished', {
          runId,
          status: 'failed',
          stopped: true
        });
        this.emit(runId);
      });
      return { ok: true };
    }

    await this.enqueue(runId, async () => {
      const current = this.options.database.getOrchestration(runId);
      if (!current) return;
      const now = Date.now();
      const wasPlanning = current.run.status === 'planning';
      const wasSummarizing = current.run.status === 'summarizing';
      current.run.status = 'stopping';
      current.run.updatedAt = now;
      if (wasPlanning && current.run.planningTerminalId) {
        this.options.terminals.stop(current.run.planningTerminalId);
      }
      if (wasSummarizing && current.run.synthesisTerminalId) {
        this.options.terminals.stop(current.run.synthesisTerminalId);
        current.run.synthesisStatus = 'fallback';
        current.run.synthesisError = 'Stopped before final synthesis finished.';
        current.run.finalSummary = fallbackSynthesis(current.run, current.tasks);
      }
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
      const previousTerminalId = currentTask.terminalId;
      if (previousTerminalId) {
        this.clearTerminalTimeout(previousTerminalId);
        this.workerSignals.delete(previousTerminalId);
        this.options.terminals.stop(previousTerminalId);
      }
      const previousSession = this.options.database.getAgentSessionByTask(currentTask.id);
      if (previousSession) {
        previousSession.status = 'stopped';
        previousSession.terminalId = undefined;
        previousSession.updatedAt = now;
        previousSession.stoppedAt = now;
        this.options.database.upsertAgentSession(previousSession);
      }
      currentTask.status = 'queued';
      currentTask.terminalId = undefined;
      currentTask.error = undefined;
      currentTask.blocker = undefined;
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
      current.run.synthesisStatus = 'idle';
      current.run.synthesisProvider = undefined;
      current.run.synthesisModel = undefined;
      current.run.synthesisTerminalId = undefined;
      current.run.finalSummary = undefined;
      current.run.synthesisError = undefined;
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
    if (this.options.database.getAgentSessionByTask(task.id)?.status === 'working') {
      throw new Error('Wait for the agent follow-up to finish before reviewing this task.');
    }
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
      if (snapshot.sessions?.some((session) => session.status === 'working')) {
        throw new Error('Wait for agent follow-ups to finish before integrating results.');
      }
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
      if (snapshot.sessions?.some((session) => session.status === 'working')) {
        throw new Error('Wait for agent follow-ups to finish before verifying results.');
      }
      if (snapshot.run.verificationStatus === 'running') throw new Error('Verification is already running.');
      const capabilities = await this.options.detectProviders();
      const requested = request.provider ?? snapshot.run.recommendedVerificationProvider;
      const provider = capabilities.find((candidate) => isProviderReady(candidate) && candidate.id === requested)
        ?? capabilities.find(isProviderReady);
      if (!provider) throw new Error('No supported CLI verifier is available.');

      const prompt = verificationPrompt(snapshot.run, this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME);
      const terminal = await this.options.terminals.spawn({
        provider: provider.id,
        outputMode: 'event-stream',
        role: 'verifier',
        avatarSeed: `${runId}-verification`,
        name: 'Verifier',
        cwd: snapshot.run.repoRoot,
        cols: 120,
        rows: 32,
        args: providerAdapter(provider.id).verificationArgs(prompt)
      });
      this.armTerminalTimeout(terminal.id, this.phaseTimeout('verification', VERIFICATION_TIMEOUT_MS), 'Verification timed out after 15 minutes.');
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
      if (snapshot.sessions?.some((session) => ['starting', 'working', 'stopping'].includes(session.status))) {
        throw new Error('Wait for agent follow-ups to finish before cleaning worktrees.');
      }
      if (!['passed', 'failed'].includes(snapshot.run.verificationStatus ?? 'idle')) {
        throw new Error('Run final verification before cleanup.');
      }
      const failures: string[] = [];
      for (const task of snapshot.tasks) {
        if (!task.worktreeId) continue;
        const session = this.options.database.getAgentSessionByTask(task.id);
        if (session?.terminalId) {
          this.clearTerminalTimeout(session.terminalId);
          this.workerSignals.delete(session.terminalId);
          this.options.terminals.stop(session.terminalId, true);
          task.terminalId = undefined;
        }
        const result = await this.options.worktrees.remove({ id: task.worktreeId, force: true });
        if (!result.ok) failures.push(result.error ?? task.title);
        else {
          if (session) this.closeAgentSession(session, 'Run cleanup removed this agent worktree.');
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
    if (!task) return;
    if (task.status === 'starting') {
      void this.enqueue(task.runId, async () => {
        const current = this.options.database.getOrchestrationTask(task.id);
        if (!current || current.status !== 'starting') return;
        current.status = 'running';
        current.updatedAt = Date.now();
        this.options.database.updateOrchestrationTask(current);
        this.emit(current.runId);
      });
    }

    const signal = this.workerSignals.get(event.id);
    if (!signal || signal.settling) return;
    signal.transcript = appendBounded(signal.transcript, event.data, MAX_WORKER_SIGNAL_BUFFER);
    const plain = stripTerminalControl(signal.transcript);
    const blocker = interactiveBlocker(plain, signal.blockedMarker);
    if (!blocker && !plain.includes(signal.completionMarker)) return;
    signal.settling = true;
    if (signal.kind === 'followup') void this.finishAgentFollowup(event.id, blocker);
    else void this.finishInteractiveTask(event.id, blocker);
  }

  handleTerminalExit(event: TerminalExitEvent): void {
    const timeoutReason = this.clearTerminalTimeout(event.id);
    const task = this.options.database.getOrchestrationTaskByTerminal(event.id);
    if (!task) {
      const planning = this.options.database.getOrchestrationByPlanningTerminal(event.id);
      if (planning) {
        void this.enqueue(planning.run.id, async () => {
          const current = this.options.database.getOrchestration(planning.run.id);
          if (!current || current.run.status !== 'planning') return;
          const replay = this.providerReplay(current.run.planningProvider, this.safeReplay(event.id));
          const fallback = this.fallbackPlan(current.run);
          try {
            if (timeoutReason) throw new Error(timeoutReason);
            if (event.exitCode !== 0) throw new Error(providerFailureMessage('Planner', replay, event.exitCode));
            const parsed = parseIntelligentPlan(replay.data, {
              providers: current.run.planningProviders ?? [],
              profiles: this.planningCandidates(current.run),
              objective: current.run.objective,
              strategy: current.run.strategy
            });
            this.materializePlan(current.run, parsed.tasks, parsed.summary, 'model');
          } catch (error) {
            this.materializePlan(
              current.run,
              fallback,
              'Michael used a safe fallback plan.',
              'fallback',
              messageOf(error)
            );
          }
        });
        return;
      }
      const synthesis = this.options.database.getOrchestrationBySynthesisTerminal(event.id);
      if (synthesis) {
        void this.enqueue(synthesis.run.id, async () => {
          const current = this.options.database.getOrchestration(synthesis.run.id);
          if (!current || current.run.synthesisStatus !== 'running') return;
          const replay = this.providerReplay(current.run.synthesisProvider, this.safeReplay(event.id));
          try {
            if (timeoutReason) throw new Error(timeoutReason);
            if (event.exitCode !== 0) throw new Error(providerFailureMessage('Outcome writer', replay, event.exitCode));
            this.finalizeSynthesis(current, parseIntelligentSynthesis(replay.data), 'completed');
          } catch (error) {
            this.finalizeSynthesis(
              current,
              fallbackSynthesis(current.run, current.tasks),
              'fallback',
              messageOf(error)
            );
          }
        });
        return;
      }
      const verification = this.options.database.getOrchestrationByVerificationTerminal(event.id);
      if (!verification) return;
      void this.enqueue(verification.run.id, async () => {
        const current = this.options.database.getOrchestration(verification.run.id);
        if (!current || current.run.verificationStatus !== 'running') return;
        const replay = this.providerReplay(current.run.verificationProvider, this.safeReplay(event.id));
        const verdict = verificationVerdict(replay);
        current.run.verificationStatus = !timeoutReason && event.exitCode === 0 && verdict.status === 'passed'
          ? 'passed'
          : 'failed';
        current.run.verificationSummary = summaryFromReplay(replay);
        current.run.verificationError = timeoutReason
          ?? (event.exitCode !== 0
            ? providerFailureMessage('Verifier', replay, event.exitCode)
            : verdict.status === 'failed'
              ? verdict.reason
              : undefined);
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
    const activeSignal = this.workerSignals.get(event.id);
    if (activeSignal?.kind === 'followup') {
      activeSignal.exit = { exitCode: event.exitCode, exitedAt: event.exitedAt, timeoutReason };
      if (!activeSignal.settling) {
        activeSignal.settling = true;
        void this.finishAgentFollowup(event.id);
      }
      return;
    }
    void this.enqueue(task.runId, async () => {
      const current = this.options.database.getOrchestrationTask(task.id);
      const run = this.options.database.getOrchestration(task.runId)?.run;
      if (!current || !run) return;
      if (isFinalTask(current.status)) {
        const settledSession = this.options.database.getAgentSessionByTerminal(event.id);
        if (settledSession) {
          const stoppedByUser = settledSession.status === 'stopping';
          settledSession.status = stoppedByUser || (!timeoutReason && event.exitCode === 0) ? 'stopped' : 'failed';
          settledSession.updatedAt = event.exitedAt;
          settledSession.lastActiveAt = event.exitedAt;
          settledSession.stoppedAt = event.exitedAt;
          settledSession.error = stoppedByUser ? undefined : timeoutReason ?? (event.exitCode === 0
            ? settledSession.error
            : `${DEFAULT_AGENT_NAMES[settledSession.provider]} exited with code ${event.exitCode}.`);
          this.options.database.upsertAgentSession(settledSession);
        }
        this.workerSignals.delete(event.id);
        this.emit(current.runId);
        return;
      }
      const stopped = current.status === 'stopping' || run.status === 'stopping' || run.status === 'stopped';
      const replay = this.providerReplay(current.provider, this.safeReplay(event.id));
      current.summary = summaryFromReplay(replay);
      current.blocker = stopped ? undefined : blockerFromReplay(replay);
      current.status = stopped ? 'stopped' : current.blocker ? 'blocked' : !timeoutReason && event.exitCode === 0 ? 'completed' : 'failed';
      current.error = current.status === 'failed'
        ? timeoutReason ?? providerFailureMessage(DEFAULT_AGENT_NAMES[current.provider], replay, event.exitCode)
        : undefined;
      current.updatedAt = event.exitedAt;
      current.completedAt = event.exitedAt;
      this.options.database.updateOrchestrationTask(current);
      this.workerSignals.delete(event.id);
      const session = this.options.database.getAgentSessionByTask(current.id);
      if (session) {
        session.status = current.status === 'failed' ? 'failed' : 'stopped';
        session.updatedAt = event.exitedAt;
        session.lastActiveAt = event.exitedAt;
        session.stoppedAt = event.exitedAt;
        session.error = current.error ?? current.blocker;
        this.options.database.upsertAgentSession(session);
      }
      this.options.database.appendEvent('orchestration.task.finished', {
        runId: current.runId,
        taskId: current.id,
        sessionId: session?.id,
        status: current.status,
        exitCode: event.exitCode
      });
      this.message(
        current.runId,
        current.id,
        current.status === 'blocked' || current.status === 'failed' ? 'blocker' : 'result',
        current.agentName ?? personNameForSeed(current.id),
        current.blocker ?? current.error ?? current.summary ?? `${current.title} finished.`
      );
      this.reconcileRun(current.runId);
      this.emit(current.runId);
    }).then(() => this.pump(task.runId));
  }

  private async finishInteractiveTask(terminalId: string, blocker?: string): Promise<void> {
    const signal = this.workerSignals.get(terminalId);
    if (!signal) return;
    const task = this.options.database.getOrchestrationTask(signal.taskId);
    if (!task) {
      this.workerSignals.delete(terminalId);
      return;
    }
    this.clearTerminalTimeout(terminalId);
    await this.enqueue(task.runId, async () => {
      const current = this.options.database.getOrchestrationTask(task.id);
      if (!current || isFinalTask(current.status)) return;
      const now = Date.now();
      const replay = this.safeReplay(terminalId);
      const transcript = replay.data || signal.transcript;
      const session = this.options.database.getAgentSessionByTerminal(terminalId);
      current.summary = await this.workerSummary(session, signal, transcript);
      current.blocker = blocker;
      current.status = blocker ? 'blocked' : 'completed';
      current.error = undefined;
      current.updatedAt = now;
      current.completedAt = now;
      this.options.database.updateOrchestrationTask(current);

      if (session) {
        session.status = 'idle';
        session.updatedAt = now;
        session.lastActiveAt = now;
        session.stoppedAt = undefined;
        session.error = blocker;
        this.options.database.upsertAgentSession(session);
      }
      this.options.database.appendEvent('orchestration.task.finished', {
        runId: current.runId,
        taskId: current.id,
        sessionId: session?.id,
        status: current.status,
        terminalId,
        processAlive: true
      });
      this.message(
        current.runId,
        current.id,
        blocker ? 'blocker' : 'result',
        current.agentName ?? personNameForSeed(current.id),
        blocker ?? current.summary ?? `${current.title} finished.`
      );
      this.reconcileRun(current.runId);
      this.emit(current.runId);
    });
    this.workerSignals.delete(terminalId);
    await this.pump(task.runId);
  }

  private async finishAgentFollowup(terminalId: string, blocker?: string): Promise<void> {
    const signal = this.workerSignals.get(terminalId);
    if (!signal?.sessionId) return;
    const session = this.options.database.getAgentSession(signal.sessionId);
    if (!session) {
      this.workerSignals.delete(terminalId);
      return;
    }
    this.clearTerminalTimeout(terminalId);
    const checkpoint = await this.captureTaskDiff(signal.taskId);
    await this.enqueue(session.runId, async () => {
      const current = this.options.database.getAgentSession(session.id);
      if (!current || current.terminalId !== terminalId) return;
      const now = Date.now();
      const task = this.options.database.getOrchestrationTask(signal.taskId);
      const snapshot = this.options.database.getOrchestration(current.runId);
      const comparison = signal.baselineDiff && checkpoint.fingerprint
        ? signal.baselineDiff === checkpoint.fingerprint ? 'unchanged' : 'changed'
        : 'unavailable';
      const replay = this.safeReplay(terminalId);
      const stoppedByUser = signal.stopRequested === true;
      const followupError = !stoppedByUser && signal.exit && (signal.exit.timeoutReason || signal.exit.exitCode !== 0)
        ? signal.exit.timeoutReason
          ?? providerFailureMessage(DEFAULT_AGENT_NAMES[current.provider], replay, signal.exit.exitCode)
        : undefined;
      const needsReconciliation = comparison === 'changed'
        || Boolean(blocker)
        || (signal.baselineTaskStatus !== undefined && signal.baselineTaskStatus !== 'completed');
      current.status = stoppedByUser ? 'stopped' : signal.exit ? followupError ? 'failed' : 'stopped' : 'idle';
      current.updatedAt = signal.exit?.exitedAt ?? now;
      current.lastActiveAt = current.updatedAt;
      current.stoppedAt = stoppedByUser ? signal.exit?.exitedAt ?? now : signal.exit?.exitedAt;
      current.error = blocker ?? followupError;
      this.options.database.upsertAgentSession(current);

      if (task && snapshot && needsReconciliation) {
        if (snapshot.run.synthesisStatus === 'running' && snapshot.run.synthesisTerminalId) {
          this.clearTerminalTimeout(snapshot.run.synthesisTerminalId);
          this.options.terminals.stop(snapshot.run.synthesisTerminalId);
        }
        if (snapshot.run.verificationStatus === 'running' && snapshot.run.verificationTerminalId) {
          this.clearTerminalTimeout(snapshot.run.verificationTerminalId);
          this.options.terminals.stop(snapshot.run.verificationTerminalId);
        }

        const transcript = signal.transcript || replay.data;
        task.summary = await this.workerSummary(current, signal, transcript);
        task.status = blocker ? 'blocked' : stoppedByUser ? 'stopped' : followupError ? 'failed' : 'completed';
        task.blocker = blocker;
        task.error = followupError;
        task.completedAt = signal.exit?.exitedAt ?? now;
        task.updatedAt = task.completedAt;
        task.reviewStatus = 'pending';
        task.integrationStatus = 'pending';
        task.integrationCommit = undefined;
        task.integrationError = undefined;
        task.reviewedAt = undefined;
        task.integratedAt = undefined;

        snapshot.run.status = task.status === 'blocked'
          ? 'blocked'
          : task.status === 'failed' ? 'failed' : task.status === 'stopped' ? 'stopped' : 'queued';
        snapshot.run.error = undefined;
        snapshot.run.completedAt = undefined;
        snapshot.run.integrationStatus = 'pending';
        snapshot.run.integrationError = undefined;
        snapshot.run.verificationStatus = 'idle';
        snapshot.run.verificationProvider = undefined;
        snapshot.run.verificationTerminalId = undefined;
        snapshot.run.verificationSummary = undefined;
        snapshot.run.verificationError = undefined;
        snapshot.run.synthesisStatus = 'idle';
        snapshot.run.synthesisProvider = undefined;
        snapshot.run.synthesisModel = undefined;
        snapshot.run.synthesisTerminalId = undefined;
        snapshot.run.finalSummary = undefined;
        snapshot.run.synthesisError = undefined;
        snapshot.run.updatedAt = now;
        this.options.database.updateOrchestrationTask(task);
        this.options.database.updateOrchestrationRun(snapshot.run);
        this.message(
          current.runId,
          task.id,
          blocker || followupError || stoppedByUser ? 'blocker' : 'result',
          current.agentName,
          blocker ?? followupError ?? (stoppedByUser
            ? `${task.title} stopped during a follow-up. Resume the agent before reviewing partial work.`
            : comparison === 'changed'
            ? `${task.title} changed after a follow-up. Review and integration are required again.`
            : task.summary ?? `${task.title} is ready again.`)
        );
        this.reconcileRun(current.runId);
      } else {
        this.message(
          current.runId,
          task?.id,
          'status',
          current.agentName,
          stoppedByUser
            ? `${current.agentName}'s follow-up was stopped without changing the worktree.`
            : followupError
            ? `${current.agentName}'s follow-up session ended without changing the worktree.`
            : comparison === 'unchanged'
            ? `${current.agentName} answered the follow-up without changing the worktree.`
            : `${current.agentName} answered the follow-up; Relay could not compare the worktree.`
        );
      }
      this.options.database.appendEvent('orchestration.agent_session.followup_finished', {
        sessionId: current.id,
        runId: current.runId,
        terminalId,
        status: blocker ? 'blocked' : stoppedByUser ? 'stopped' : followupError ? 'failed' : 'completed',
        exitCode: signal.exit?.exitCode,
        worktreeComparison: comparison,
        reconciled: needsReconciliation,
        worktreeCheckpointError: checkpoint.error ?? signal.baselineDiffError
      });
      this.emit(current.runId);
    });
    this.workerSignals.delete(terminalId);
  }

  private async workerSummary(
    session: AgentSession | undefined,
    signal: InteractiveWorkerSignal,
    terminalTranscript: string
  ): Promise<string | undefined> {
    if (!session?.worktreePath || !this.options.readWorkerResult) {
      return interactiveSummary(terminalTranscript, signal.completionMarker, signal.blockedMarker);
    }
    try {
      let nativeSessionId = session.nativeSessionId;
      if (!nativeSessionId && this.options.resolveWorkerSessionId) {
        nativeSessionId = await this.options.resolveWorkerSessionId(
          session.provider,
          session.worktreePath,
          session.startedAt ?? session.createdAt
        );
        if (nativeSessionId) {
          session.nativeSessionId = nativeSessionId;
          session.updatedAt = Date.now();
          this.options.database.upsertAgentSession(session);
        }
      }
      if (nativeSessionId) {
        const nativeResult = await this.options.readWorkerResult(
          session.provider,
          session.worktreePath,
          nativeSessionId,
          session.startedAt ?? session.createdAt,
          signal.completionMarker
        );
        if (nativeResult) {
          return structuredWorkerSummary(nativeResult, signal.completionMarker, signal.blockedMarker);
        }
      }
    } catch (error) {
      this.options.logger.warn({ error, sessionId: session.id }, 'Could not read structured provider result');
    }
    return interactiveSummary(terminalTranscript, signal.completionMarker, signal.blockedMarker);
  }

  private async captureTaskDiff(taskId: string): Promise<{ fingerprint?: string; error?: string }> {
    const task = this.options.database.getOrchestrationTask(taskId);
    if (!task?.worktreeId) return { error: 'The task worktree is unavailable.' };
    try {
      const diff = await this.options.worktrees.diff(task.worktreeId, task.id);
      const fingerprint = diff.fingerprint ?? createHash('sha256').update(JSON.stringify({
        branch: diff.branch,
        baseBranch: diff.baseBranch,
        files: [...diff.files].sort((left, right) => left.path.localeCompare(right.path)),
        additions: diff.additions,
        deletions: diff.deletions,
        patch: diff.patch,
        truncated: diff.truncated
      })).digest('hex');
      return { fingerprint };
    } catch (error) {
      const message = messageOf(error);
      this.options.logger.warn({ taskId, error: message }, 'Could not checkpoint the agent worktree');
      return { error: message };
    }
  }

  private closeAgentSession(session: AgentSession, reason: string): void {
    const now = Date.now();
    session.status = 'closed';
    session.worktreeId = undefined;
    session.worktreePath = undefined;
    session.terminalId = undefined;
    session.updatedAt = now;
    session.lastActiveAt = now;
    session.stoppedAt = now;
    session.error = undefined;
    this.options.database.upsertAgentSession(session);
    this.options.database.appendEvent('orchestration.agent_session.closed', {
      sessionId: session.id,
      runId: session.runId,
      reason
    });
  }

  private async startPlanning(run: OrchestrationRun, fallback: PlannedTask[]): Promise<void> {
    const configured = this.options.getOrchestratorConfig?.();
    const capabilities = await this.options.detectProviders();
    const planner = capabilities.find((candidate) => isProviderReady(candidate) && candidate.id === configured?.provider)
      ?? capabilities.find(isProviderReady);
    if (!planner) {
      this.materializePlan(run, fallback, 'No planner CLI was available; Relay used its safe plan.', 'fallback', 'No planner CLI is available.');
      return;
    }

    run.planningProvider = planner.id;
    run.planningModel = configured?.provider === planner.id ? configured.model ?? undefined : undefined;
    run.updatedAt = Date.now();
    this.options.database.updateOrchestrationRun(run);
    this.emit(run.id);
    try {
      const prompt = intelligentPlanningPrompt({
        orchestratorName: this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME,
        objective: run.objective,
        strategy: run.strategy,
        baseBranch: run.baseBranch,
        providers: run.planningProviders ?? [],
        profiles: this.planningCandidates(run),
        replanContext: run.replanContext
      });
      const terminal = await this.options.terminals.spawn({
        provider: planner.id,
        outputMode: 'event-stream',
        role: 'planner',
        avatarSeed: `${run.id}-planner`,
        name: `${this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME} Plan`,
        cwd: run.repoRoot,
        cols: 120,
        rows: 32,
        args: providerAdapter(planner.id).planningArgs(prompt, run.planningModel)
      });
      this.armTerminalTimeout(terminal.id, this.phaseTimeout('planning', PLANNING_TIMEOUT_MS), 'Planning timed out after 5 minutes.');
      run.planningTerminalId = terminal.id;
      run.updatedAt = Date.now();
      this.options.database.updateOrchestrationRun(run);
      this.options.database.appendEvent('orchestration.planning.started', {
        runId: run.id,
        provider: planner.id,
        model: run.planningModel,
        terminalId: terminal.id
      });
      this.emit(run.id);
    } catch (error) {
      this.materializePlan(run, fallback, 'Michael used a safe fallback plan.', 'fallback', messageOf(error));
    }
  }

  private planningCandidates(run: OrchestrationRun): AgentProfile[] {
    const available = new Set(run.planningProviders ?? []);
    const profiles = this.options.database.listAgentProfiles()
      .filter((profile) => profile.enabled && available.has(profile.provider));
    const selected = run.planningProfileIds ?? [];
    return selected.length > 0 ? selected.flatMap((id) => profiles.filter((profile) => profile.id === id)) : profiles;
  }

  private fallbackPlan(run: OrchestrationRun): PlannedTask[] {
    const selected = run.planningProfileIds ?? [];
    const profiles = this.planningCandidates(run);
    return selected.length > 0 && profiles.length === selected.length
      ? planObjectiveForAgents(run.objective, profiles.map((profile) => ({
          provider: profile.provider,
          profileId: profile.id,
          name: profile.name,
          avatarSeed: profile.avatarSeed,
          model: profile.model,
          instructions: profile.instructions
        })), run.strategy)
      : planObjective(run.objective, run.planningProviders ?? [], run.strategy);
  }

  private materializePlan(
    run: OrchestrationRun,
    plans: PlannedTask[],
    summary: string,
    source: 'model' | 'fallback',
    error?: string
  ): void {
    const now = Date.now();
    const selectedProfiles = (run.planningProfileIds?.length ?? 0) > 0
      ? this.planningCandidates(run)
      : [];
    const verification = recommendedVerificationAssignment(
      run.objective,
      selectedProfiles.length > 0
        ? selectedProfiles.map((profile) => ({
            provider: profile.provider,
            profileId: profile.id,
            name: profile.name,
            instructions: profile.instructions
          }))
        : (run.planningProviders ?? []).map((provider) => ({ provider })),
      plans
    );
    const tasks = plans.map((plan, ordinal): OrchestrationTask => ({
      id: `task-${randomUUID().slice(0, 12)}`,
      runId: run.id,
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
      profileId: plan.profileId,
      agentName: plan.agentName,
      avatarSeed: plan.avatarSeed,
      model: plan.model,
      profileInstructions: plan.profileInstructions,
      assignmentReason: plan.assignmentReason,
      createdAt: now,
      updatedAt: now
    }));
    run.status = 'queued';
    run.concurrency = Math.max(1, Math.min(run.concurrency, tasks.length));
    run.planningSummary = (source === 'fallback'
      ? fallbackRoutingSummary(plans, verification?.provider)
      : summary).slice(0, 500);
    run.planningSource = source;
    run.planningError = error?.slice(0, 500);
    run.recommendedVerificationProvider = verification?.provider;
    run.verificationAssignmentReason = verification?.reason;
    run.updatedAt = now;
    this.options.database.createOrchestration({ run, tasks });
    this.options.database.appendEvent('orchestration.planning.finished', {
      runId: run.id,
      source,
      taskCount: tasks.length,
      error: run.planningError
    });
    this.emit(run.id);
    void this.pump(run.id);
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
    let session: AgentSession | undefined;
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

      const previousSession = (task.agentSessionId
        ? this.options.database.getAgentSession(task.agentSessionId)
        : undefined) ?? this.options.database.getAgentSessionByTask(task.id);
      session = this.prepareAgentSession(run, task);
      if (task.provider === 'cursor' && !session.nativeSessionId && this.options.createWorkerSessionId) {
        session.nativeSessionId = await this.options.createWorkerSessionId(task.provider, task.worktreePath);
        if (!session.nativeSessionId) throw new Error('Cursor did not return a reusable chat identity.');
        session.updatedAt = Date.now();
        this.options.database.upsertAgentSession(session);
      }
      const completionToken = randomUUID().replace(/-/g, '').slice(0, 20);
      const prompt = workerPrompt(
        run,
        task,
        this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME,
        completionToken
      );
      const spawnedTerminal = await this.options.terminals.spawn({
        provider: task.provider,
        outputMode: 'terminal',
        avatarSeed: task.avatarSeed ?? task.id,
        cwd: task.worktreePath,
        name: task.agentName ?? personNameForSeed(task.id),
        cols: 120,
        rows: 32,
        args: previousSession?.nativeSessionId
          ? providerAdapter(task.provider).resumeWorkerArgs(task.model, previousSession.nativeSessionId)
          : providerAdapter(task.provider).interactiveWorkerArgs(task.model, session.nativeSessionId)
      });
      const terminal = this.options.prepareWorkerTerminal
        ? await this.options.prepareWorkerTerminal(spawnedTerminal, task.worktreePath)
        : spawnedTerminal;
      task.terminalId = terminal.id;
      task.status = 'running';
      task.error = undefined;
      task.updatedAt = Date.now();
      session.terminalId = terminal.id;
      session.status = 'working';
      session.updatedAt = task.updatedAt;
      session.lastActiveAt = task.updatedAt;
      session.stoppedAt = undefined;
      session.error = undefined;
      this.options.database.upsertAgentSession(session);
      this.options.database.updateOrchestrationTask(task);
      this.workerSignals.set(terminal.id, {
        kind: 'task',
        taskId: task.id,
        completionMarker: `RELAY_TASK_COMPLETE:${completionToken}`,
        blockedMarker: `RELAY_TASK_BLOCKED:${completionToken}:`,
        transcript: '',
        settling: false
      });
      this.armTerminalTimeout(terminal.id, this.phaseTimeout('worker', WORKER_TIMEOUT_MS), 'Worker timed out after 45 minutes.');
      const submitted = await this.options.terminals.submit(terminal.id, prompt);
      if (!submitted.ok) throw new Error(submitted.error ?? 'Could not submit the worker task.');
      void this.captureNativeSessionId(session.id, terminal.id);
      this.options.database.appendEvent('orchestration.task.started', {
        runId: run.id,
        taskId: task.id,
        provider: task.provider,
        terminalId: terminal.id,
        sessionId: session.id,
        worktreeId: task.worktreeId
      });
      this.message(run.id, task.id, 'status', task.agentName ?? personNameForSeed(task.id), `Started ${task.title}.`);
      this.options.logger.info(
        { runId: run.id, taskId: task.id, provider: task.provider, terminalId: terminal.id },
        'Orchestrator worker started'
      );
    } catch (error) {
      if (session?.terminalId) {
        this.clearTerminalTimeout(session.terminalId);
        this.workerSignals.delete(session.terminalId);
        this.options.terminals.stop(session.terminalId);
      }
      task.status = 'failed';
      task.error = messageOf(error);
      task.updatedAt = Date.now();
      task.completedAt = task.updatedAt;
      if (session) {
        session.status = 'failed';
        session.error = task.error;
        session.updatedAt = task.updatedAt;
        session.stoppedAt = task.updatedAt;
        this.options.database.upsertAgentSession(session);
      }
      this.options.database.updateOrchestrationTask(task);
      this.options.database.appendEvent('orchestration.task.failed', {
        runId: run.id,
        taskId: task.id,
        error: task.error
      });
      this.message(run.id, task.id, 'blocker', task.agentName ?? personNameForSeed(task.id), task.error);
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
    } else if (statuses.has('queued') || statuses.has('starting') || statuses.has('running')) {
      snapshot.run.status = 'running';
    } else if ((snapshot.run.synthesisStatus ?? 'idle') === 'idle' && snapshot.tasks.length > 0) {
      snapshot.run.status = 'summarizing';
      snapshot.run.synthesisStatus = 'running';
      snapshot.run.completedAt = undefined;
      snapshot.run.error = undefined;
      snapshot.run.updatedAt = now;
      this.options.database.updateOrchestrationRun(snapshot.run);
      this.options.database.appendEvent('orchestration.synthesis.queued', { runId });
      this.emit(runId);
      void this.startSynthesis(runId);
      return;
    }
    snapshot.run.updatedAt = now;
    this.options.database.updateOrchestrationRun(snapshot.run);
  }

  private async startSynthesis(runId: string): Promise<void> {
    const snapshot = this.options.database.getOrchestration(runId);
    if (!snapshot || snapshot.run.synthesisStatus !== 'running') return;
    const configured = this.options.getOrchestratorConfig?.();
    const capabilities = await this.options.detectProviders();
    const provider = capabilities.find((candidate) => isProviderReady(candidate) && candidate.id === configured?.provider)
      ?? capabilities.find(isProviderReady);
    if (!provider) {
      this.finalizeSynthesis(
        snapshot,
        fallbackSynthesis(snapshot.run, snapshot.tasks),
        'fallback',
        'No orchestrator CLI is available for final synthesis.'
      );
      return;
    }
    try {
      const model = configured?.provider === provider.id ? configured.model ?? undefined : undefined;
      const prompt = intelligentSynthesisPrompt({
        orchestratorName: this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME,
        run: snapshot.run,
        tasks: snapshot.tasks
      });
      const terminal = await this.options.terminals.spawn({
        provider: provider.id,
        outputMode: 'event-stream',
        role: 'synthesizer',
        avatarSeed: `${runId}-synthesis`,
        name: `${this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME} Outcome`,
        cwd: snapshot.run.repoRoot,
        cols: 120,
        rows: 32,
        args: providerAdapter(provider.id).planningArgs(prompt, model)
      });
      this.armTerminalTimeout(terminal.id, this.phaseTimeout('synthesis', SYNTHESIS_TIMEOUT_MS), 'Final synthesis timed out after 5 minutes.');
      const current = this.options.database.getOrchestration(runId);
      if (!current || current.run.synthesisStatus !== 'running') {
        this.options.terminals.stop(terminal.id);
        return;
      }
      current.run.synthesisProvider = provider.id;
      current.run.synthesisModel = model;
      current.run.synthesisTerminalId = terminal.id;
      current.run.updatedAt = Date.now();
      this.options.database.updateOrchestrationRun(current.run);
      this.options.database.appendEvent('orchestration.synthesis.started', {
        runId,
        provider: provider.id,
        model,
        terminalId: terminal.id
      });
      this.emit(runId);
    } catch (error) {
      const current = this.options.database.getOrchestration(runId) ?? snapshot;
      this.finalizeSynthesis(
        current,
        fallbackSynthesis(current.run, current.tasks),
        'fallback',
        messageOf(error)
      );
    }
  }

  private finalizeSynthesis(
    snapshot: OrchestrationSnapshot,
    summary: string,
    status: 'completed' | 'fallback',
    error?: string
  ): void {
    const now = Date.now();
    const statuses = new Set(snapshot.tasks.map((task) => task.status));
    snapshot.run.synthesisStatus = status;
    snapshot.run.finalSummary = summary.slice(0, 2_000);
    snapshot.run.synthesisError = error?.slice(0, 500);
    snapshot.run.status = statuses.has('blocked')
      ? 'blocked'
      : statuses.has('failed')
        ? 'failed'
        : statuses.has('stopped')
          ? 'stopped'
          : 'completed';
    snapshot.run.error = snapshot.run.status === 'blocked'
      ? 'One or more tasks need attention.'
      : snapshot.run.status === 'failed'
        ? 'One or more tasks failed.'
        : undefined;
    snapshot.run.completedAt = now;
    snapshot.run.updatedAt = now;
    this.options.database.updateOrchestrationRun(snapshot.run);
    this.options.database.appendEvent('orchestration.synthesis.finished', {
      runId: snapshot.run.id,
      status,
      runStatus: snapshot.run.status,
      error: snapshot.run.synthesisError
    });
    this.message(
      snapshot.run.id,
      undefined,
      'summary',
      this.options.getOrchestratorName?.() ?? DEFAULT_ORCHESTRATOR_NAME,
      snapshot.run.finalSummary
    );
    this.emit(snapshot.run.id);
  }

  private message(
    runId: string,
    taskId: string | undefined,
    kind: HiveCoordinationMessage['kind'],
    from: string,
    body: string | undefined
  ): void {
    if (!body) return;
    this.options.onCoordinationMessage?.({
      id: `message-${randomUUID().slice(0, 12)}`,
      runId,
      taskId,
      from,
      to: 'orchestrator',
      kind,
      body: body.slice(0, 2_000),
      createdAt: Date.now()
    });
  }

  private armTerminalTimeout(terminalId: string, durationMs: number, reason: string): void {
    const previous = this.terminalTimeouts.get(terminalId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.terminalTimeouts.delete(terminalId);
      this.timeoutReasons.set(terminalId, reason);
      this.options.database.appendEvent('terminal.timed_out', { terminalId, reason });
      this.options.logger.warn({ terminalId, durationMs }, reason);
      this.options.terminals.stop(terminalId);
    }, durationMs);
    timer.unref();
    this.terminalTimeouts.set(terminalId, timer);
  }

  private phaseTimeout(
    phase: 'planning' | 'worker' | 'synthesis' | 'verification',
    fallback: number
  ): number {
    const configured = this.options.phaseTimeouts?.[phase];
    return Number.isFinite(configured) ? Math.max(10, Math.round(configured!)) : fallback;
  }

  private clearTerminalTimeout(terminalId: string): string | undefined {
    const timer = this.terminalTimeouts.get(terminalId);
    if (timer) clearTimeout(timer);
    this.terminalTimeouts.delete(terminalId);
    const reason = this.timeoutReasons.get(terminalId);
    this.timeoutReasons.delete(terminalId);
    return reason;
  }

  private safeReplay(terminalId: string): TerminalReplay {
    try {
      return this.options.terminals.replay(terminalId);
    } catch {
      return { data: '', lastSequence: 0 };
    }
  }

  private providerReplay(provider: ProviderId | undefined, replay: TerminalReplay): TerminalReplay {
    if (!provider) return replay;
    return { ...replay, data: extractProviderResult(provider, replay.data) };
  }

  private prepareAgentSession(run: OrchestrationRun, task: OrchestrationTask): AgentSession {
    const now = Date.now();
    const existing = (task.agentSessionId
      ? this.options.database.getAgentSession(task.agentSessionId)
      : undefined) ?? this.options.database.getAgentSessionByTask(task.id);
    const session: AgentSession = existing
      ? {
          ...existing,
          provider: task.provider,
          status: 'starting',
          worktreeId: task.worktreeId,
          worktreePath: task.worktreePath,
          branch: task.branch,
          terminalId: undefined,
          profileId: task.profileId,
          agentName: task.agentName ?? personNameForSeed(task.id),
          avatarSeed: task.avatarSeed ?? task.id,
          model: task.model,
          updatedAt: now,
          startedAt: existing.startedAt ?? now,
          lastActiveAt: now,
          stoppedAt: undefined,
          error: undefined
        }
      : {
          id: `session-${randomUUID().slice(0, 12)}`,
          runId: run.id,
          initialTaskId: task.id,
          provider: task.provider,
          status: 'starting',
          worktreeId: task.worktreeId,
          worktreePath: task.worktreePath,
          branch: task.branch,
          profileId: task.profileId,
          agentName: task.agentName ?? personNameForSeed(task.id),
          avatarSeed: task.avatarSeed ?? task.id,
          model: task.model,
          nativeSessionId: task.provider === 'claude' ? randomUUID() : undefined,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          lastActiveAt: now
        };
    this.options.database.upsertAgentSession(session);
    if (task.agentSessionId !== session.id) {
      task.agentSessionId = session.id;
      task.updatedAt = now;
      this.options.database.updateOrchestrationTask(task);
    }
    if (!existing) {
      this.options.database.appendEvent('orchestration.agent_session.created', {
        sessionId: session.id,
        runId: run.id,
        taskId: task.id,
        provider: task.provider,
        worktreeId: task.worktreeId
      });
    }
    return session;
  }

  private async captureNativeSessionId(sessionId: string, terminalId: string): Promise<void> {
    if (!this.options.resolveWorkerSessionId || this.nativeSessionLookups.has(terminalId)) return;
    const session = this.options.database.getAgentSession(sessionId);
    if (!session || session.nativeSessionId || !session.worktreePath) return;
    this.nativeSessionLookups.add(terminalId);
    try {
      const nativeSessionId = await this.options.resolveWorkerSessionId(
        session.provider,
        session.worktreePath,
        session.startedAt ?? session.createdAt
      );
      if (!nativeSessionId) return;
      await this.enqueue(session.runId, async () => {
        const current = this.options.database.getAgentSession(session.id);
        if (!current || current.nativeSessionId || current.terminalId !== terminalId) return;
        current.nativeSessionId = nativeSessionId;
        current.updatedAt = Date.now();
        this.options.database.upsertAgentSession(current);
        this.options.database.appendEvent('orchestration.agent_session.identity_captured', {
          sessionId: current.id,
          runId: current.runId,
          terminalId,
          provider: current.provider,
          nativeSessionId
        });
        this.emit(current.runId);
      });
    } catch (error) {
      this.options.logger.warn({ error, sessionId, terminalId }, 'Could not capture provider session identity');
    } finally {
      this.nativeSessionLookups.delete(terminalId);
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

function workerPrompt(
  run: OrchestrationRun,
  task: OrchestrationTask,
  orchestratorName: string,
  completionToken: string
): string {
  return [
    `You are ${task.agentName ?? personNameForSeed(task.id)}, a Relay worker coordinated by ${orchestratorName}.`,
    `Provider: ${DEFAULT_AGENT_NAMES[task.provider]}.`,
    `Objective: ${run.objective}`,
    `Role: ${task.role}`,
    task.assignmentReason ? `Assignment reason: ${task.assignmentReason}.` : '',
    `Your task: ${task.instructions}`,
    `Expected deliverable: ${task.deliverable}`,
    task.profileInstructions ? `Agent profile: ${task.profileInstructions}` : '',
    `Branch: ${task.branch ?? '(preparing)'}`,
    'Work only inside the current worktree. Do not modify other checkouts or merge branches.',
    'Do not commit unless the objective explicitly asks for a commit.',
    'Inspect existing code first, implement the task, run proportionate checks, then give a concise final summary.',
    `When successful, finish with a machine marker made by joining these two parts with no spaces: ` +
      `\`RELAY_TASK_\` + \`COMPLETE:${completionToken}\`.`,
    `If blocked, finish instead with a marker made by joining \`RELAY_TASK_\` + ` +
      `\`BLOCKED:${completionToken}: <short reason>\` with no space around the plus sign.`,
    'After emitting either marker, wait for the next instruction and do not exit the CLI.'
  ].filter(Boolean).join('\n\n').slice(0, 4_000);
}

function fallbackRoutingSummary(tasks: PlannedTask[], verifier?: ProviderId): string {
  const assignments = tasks.map((task) =>
    `${DEFAULT_AGENT_NAMES[task.provider]} ${task.role === 'owner' ? 'owns delivery' : `handles ${task.role}`}`
  );
  const verification = verifier ? `${DEFAULT_AGENT_NAMES[verifier]} is recommended for verification.` : '';
  return [...assignments, verification].filter(Boolean).join('. ');
}

function agentFollowupPrompt(prompt: string, completionToken: string): string {
  return [
    prompt,
    'This is a follow-up in your existing Relay agent session. Keep working only inside the current worktree.',
    'Complete the request, run proportionate checks, and answer concisely.',
    `When ready for another instruction, finish with a marker made by joining \`RELAY_AGENT_\` + ` +
      `\`READY:${completionToken}\` with no spaces.`,
    `If blocked, finish instead by joining \`RELAY_AGENT_\` + ` +
      `\`BLOCKED:${completionToken}: <short reason>\` with no spaces.`,
    'After emitting the marker, remain open and wait for the next instruction.'
  ].join('\n\n').slice(0, MAX_AGENT_FOLLOWUP_LENGTH + 1_000);
}

function verificationPrompt(run: OrchestrationRun, orchestratorName: string): string {
  return [
    `You are the final verifier for ${orchestratorName} in Relay.`,
    `Objective: ${run.objective}`,
    `Integrated branch: ${run.baseBranch}`,
    'Inspect the integrated changes, run the most relevant existing checks, and report defects with file references.',
    'This is read-only verification. Do not edit files, create commits, or change Git state.',
    'End with a concise verdict and list the checks you ran.',
    'Your final non-empty line must be exactly `RELAY_VERDICT: PASS` when every relevant check passes, or `RELAY_VERDICT: FAIL - <short reason>` when any check fails or cannot be run.'
  ].join('\n\n').slice(0, 4_000);
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
  return [...new Set(providers.filter((provider): provider is ProviderId => PROVIDER_IDS.includes(provider)))];
}

function resolveProfiles(
  database: RelayDatabase,
  profileIds: string[],
  available: Set<ProviderId>
): AgentProfile[] {
  const ids = [...new Set(profileIds)];
  if (ids.length > MAX_CONCURRENCY) throw new Error('Choose up to four agent profiles.');
  return ids.map((id) => {
    const profile = database.getAgentProfile(id);
    if (!profile) throw new Error('An agent profile was not found.');
    if (!profile.enabled) throw new Error(`${profile.name} is disabled.`);
    if (!available.has(profile.provider)) throw new Error(`${DEFAULT_AGENT_NAMES[profile.provider]} is unavailable.`);
    return profile;
  });
}

function summaryFromReplay(replay: TerminalReplay): string | undefined {
  const plain = replay.data
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '')
    .trim();
  return plain ? plain.slice(-4_000) : undefined;
}

function appendBounded(current: string, chunk: string, maximum: number): string {
  const combined = current + chunk;
  return combined.length <= maximum ? combined : combined.slice(-maximum);
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '');
}

function interactiveBlocker(transcript: string, marker: string): string | undefined {
  const index = transcript.lastIndexOf(marker);
  if (index < 0) return undefined;
  const reason = transcript.slice(index + marker.length).split('\n')[0]?.replace(/\s+/g, ' ').trim();
  return reason ? reason.slice(0, 500) : 'The agent reported a blocker.';
}

function interactiveSummary(transcript: string, completionMarker: string, blockedMarker: string): string | undefined {
  const plain = stripTerminalControl(transcript)
    .replaceAll(completionMarker, '')
    .replaceAll(blockedMarker, 'RELAY_BLOCKER:')
    .trim();
  return plain ? plain.slice(-4_000) : undefined;
}

function structuredWorkerSummary(transcript: string, completionMarker: string, blockedMarker: string): string | undefined {
  const plain = stripTerminalControl(transcript)
    .replaceAll(completionMarker, '')
    .replaceAll(blockedMarker, 'RELAY_BLOCKER:')
    .trim();
  if (!plain) return undefined;
  if (plain.length <= 4_000) return plain;
  return `${plain.slice(0, 3_000).trimEnd()}\n\n…\n\n${plain.slice(-900).trimStart()}`;
}

function blockerFromReplay(replay: TerminalReplay): string | undefined {
  const plain = replay.data
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '');
  const matches = [...plain.matchAll(/(?:^|\n)\s*RELAY_BLOCKER:\s*(.+?)\s*(?=\n|$)/gi)];
  const reason = matches.at(-1)?.[1]?.replace(/\s+/g, ' ').trim();
  return reason ? reason.slice(0, 500) : undefined;
}

export function verificationVerdict(replay: TerminalReplay): { status: 'passed' | 'failed'; reason?: string } {
  const plain = replay.data
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '');
  const matches = [...plain.matchAll(/(?:^|\n)\s*RELAY_VERDICT:\s*(PASS|FAIL)(?:\s*-\s*(.*?))?\s*(?=\n|$)/gi)];
  const marker = matches.at(-1);
  if (!marker) {
    return { status: 'failed', reason: 'Verifier did not return a RELAY_VERDICT marker.' };
  }
  if (marker[1].toUpperCase() === 'PASS') return { status: 'passed' };
  const reason = marker[2]?.replace(/\s+/g, ' ').trim();
  return { status: 'failed', reason: reason?.slice(0, 500) || 'Verifier reported a failed check.' };
}

export function providerFailureMessage(label: string, replay: TerminalReplay, exitCode: number): string {
  const output = replay.data
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (/not logged in|login required|authentication|unauthorized|invalid api key|sign in/.test(output)) {
    return `${label} authentication is required. Sign in with the CLI, then retry.`;
  }
  if (/permission denied|operation not permitted|eacces|access denied/.test(output)) {
    return `${label} was denied filesystem access. Check folder permissions, then retry.`;
  }
  if (/rate limit|too many requests|quota exceeded|usage limit/.test(output)) {
    return `${label} reached a usage limit. Wait or change accounts, then retry.`;
  }
  if (/econn|enotfound|network error|connection (?:failed|reset)|socket hang up/.test(output)) {
    return `${label} could not reach its service. Check the network, then retry.`;
  }
  return `${label} exited with code ${exitCode}.`;
}

function replanContext(snapshot: OrchestrationSnapshot): string {
  const outcomes = snapshot.tasks.map((task) => {
    const result = task.blocker ?? task.error ?? task.summary ?? 'No worker report.';
    return `${task.title} [${task.status}]: ${result.replace(/\s+/g, ' ').slice(0, 500)}`;
  });
  return [
    `Previous run ${snapshot.run.id} ended ${snapshot.run.status}.`,
    snapshot.run.integrationError ? `Integration: ${snapshot.run.integrationError}` : '',
    snapshot.run.verificationError ? `Verification: ${snapshot.run.verificationError}` : '',
    snapshot.run.finalSummary ?? '',
    ...outcomes
  ].filter(Boolean).join(' ').slice(0, 1_800);
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
