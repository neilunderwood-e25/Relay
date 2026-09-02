import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProviderCapability,
  ProviderId,
  TerminalReplay,
  TerminalRole,
  TerminalSnapshot,
  TaskDiffSnapshot,
  HiveCoordinationMessage,
  WorktreeSnapshot
} from '../src/shared/contracts';
import { RelayDatabase } from '../src/main/database';
import { planObjective, Orchestrator, providerFailureMessage, verificationVerdict } from '../src/main/orchestrator';
import { planObjectiveForAgents, recommendedVerificationAssignment } from '../src/shared/orchestration';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeWorktrees {
  created: WorktreeSnapshot[] = [];
  integrated: string[] = [];
  removed: string[] = [];
  diffPatch = '+feature';

  constructor(private readonly root = '/worktrees') {}

  async inspect(): Promise<{
    isRepository: boolean;
    mainRoot: string;
    currentBranch: string;
    branches: string[];
  }> {
    return { isRepository: true, mainRoot: '/repo', currentBranch: 'main', branches: ['main'] };
  }

  async create(request: { name: string; baseBranch?: string }): Promise<WorktreeSnapshot> {
    const worktree: WorktreeSnapshot = {
      id: `worktree-${this.created.length + 1}`,
      repoRoot: '/repo',
      path: join(this.root, request.name),
      branch: `relay/${request.name}`,
      baseBranch: request.baseBranch ?? 'main',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      head: 'abc123',
      managed: true,
      isMain: false,
      dirty: false,
      ahead: 0,
      status: 'ready'
    };
    mkdirSync(worktree.path, { recursive: true });
    this.created.push(worktree);
    return worktree;
  }

  async diff(worktreeId: string, taskId: string): Promise<TaskDiffSnapshot> {
    const worktree = this.created.find((candidate) => candidate.id === worktreeId)!;
    return {
      taskId,
      branch: worktree.branch,
      baseBranch: worktree.baseBranch,
      files: [{ path: 'feature.ts', status: 'modified', additions: 2, deletions: 1 }],
      additions: 2,
      deletions: 1,
      patch: this.diffPatch,
      truncated: false,
      fingerprint: this.diffPatch
    };
  }

  async integrate(worktreeId: string): Promise<{ status: 'integrated'; commit: string }> {
    this.integrated.push(worktreeId);
    return { status: 'integrated', commit: `commit-${this.integrated.length}` };
  }

  async remove(request: { id: string }): Promise<{ ok: true }> {
    this.removed.push(request.id);
    return { ok: true };
  }
}

class FakeTerminals {
  spawned: Array<{ snapshot: TerminalSnapshot; args?: string[] }> = [];
  stopped: string[] = [];
  submitted: Array<{ id: string; text: string }> = [];
  submitError: string | null = null;
  replayData = new Map<string, string>();

  async spawn(request: { provider: ProviderId; role?: TerminalRole; name?: string; cwd: string; args?: string[] }): Promise<TerminalSnapshot> {
    const snapshot: TerminalSnapshot = {
      id: `terminal-${this.spawned.length + 1}`,
      role: request.role ?? 'worker',
      name: request.name ?? 'Worker',
      provider: request.provider,
      command: request.provider,
      cwd: request.cwd,
      pid: 100 + this.spawned.length,
      cols: 120,
      rows: 32,
      status: 'running',
      createdAt: Date.now(),
      lastOutputAt: 0,
      hasOutput: false,
      lastSequence: 0
    };
    this.spawned.push({ snapshot, args: request.args });
    return snapshot;
  }

  stop(id: string): { ok: true } {
    this.stopped.push(id);
    return { ok: true };
  }

  async submit(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (this.submitError) return { ok: false, error: this.submitError };
    this.submitted.push({ id, text });
    return { ok: true };
  }

  replay(id: string): TerminalReplay {
    return { data: this.replayData.get(id) ?? `summary for ${id}`, lastSequence: 1 };
  }
}

function fixture(
  phaseTimeouts?: { planning?: number; worker?: number; synthesis?: number; verification?: number },
  resolveWorkerSessionId?: (provider: ProviderId, cwd: string, startedAt: number) => Promise<string | undefined>,
  providerCapabilities: ProviderCapability[] = capabilities(),
  createWorkerSessionId?: (provider: ProviderId, cwd: string) => Promise<string | undefined>,
  readWorkerResult?: (
    provider: ProviderId,
    cwd: string,
    nativeSessionId: string,
    startedAt: number,
    requiredMarker: string
  ) => Promise<string | undefined>
): {
  database: RelayDatabase;
  worktrees: FakeWorktrees;
  terminals: FakeTerminals;
  orchestrator: Orchestrator;
  messages: HiveCoordinationMessage[];
} {
  const root = mkdtempSync(join(tmpdir(), 'relay-orchestrator-test-'));
  temporaryDirectories.push(root);
  const database = new RelayDatabase(join(root, 'relay.db'));
  database.open();
  const worktrees = new FakeWorktrees(join(root, 'worktrees'));
  const terminals = new FakeTerminals();
  const messages: HiveCoordinationMessage[] = [];
  const orchestrator = new Orchestrator({
    database,
    logger: pino({ enabled: false }),
    worktrees,
    terminals,
    detectProviders: async () => providerCapabilities,
    getOrchestratorConfig: () => ({ provider: 'claude', model: 'claude-opus-4-1' }),
    onCoordinationMessage: (message) => messages.push(message),
    resolveWorkerSessionId,
    createWorkerSessionId,
    readWorkerResult,
    phaseTimeouts
  });
  return { database, worktrees, terminals, orchestrator, messages };
}

describe('Orchestrator', () => {
  it('turns common CLI failures into actionable recovery messages', () => {
    expect(providerFailureMessage('Claude', { data: 'Not logged in. Run /login.', lastSequence: 1 }, 1))
      .toContain('authentication is required');
    expect(providerFailureMessage('Codex', { data: 'EACCES: permission denied', lastSequence: 1 }, 1))
      .toContain('filesystem access');
    expect(providerFailureMessage('Codex', { data: '429 rate limit exceeded', lastSequence: 1 }, 1))
      .toContain('usage limit');
  });
  it('routes cohesive delivery without assigning roles from provider order', () => {
    const forward = planObjective('Build authentication', ['claude', 'codex']);
    const reversed = planObjective('Build authentication', ['codex', 'claude']);
    expect(forward).toEqual(reversed);
    expect(forward).toMatchObject([{
      role: 'owner',
      deliverable: 'Working implementation',
      assignmentReason: 'Objective rotation'
    }]);
    expect(new Set([
      planObjective('Build authentication', ['claude', 'codex'])[0].provider,
      planObjective('Build payments', ['claude', 'codex'])[0].provider
    ])).toEqual(new Set(['claude', 'codex']));
    expect(planObjective('Use Codex to implement authentication and Claude to review it.', ['claude', 'codex']))
      .toMatchObject([{ provider: 'codex', role: 'owner', assignmentReason: 'Explicit request' }]);
    expect(planObjective(
      'Use Claude for implementation and Codex for an independent audit and test improvement.',
      ['claude', 'codex']
    )).toMatchObject([{ provider: 'claude', role: 'owner', assignmentReason: 'Explicit request' }]);
    expect(recommendedVerificationAssignment(
      'Use Claude for implementation and Codex for an independent audit and test improvement.',
      [{ provider: 'claude' }, { provider: 'codex' }],
      [{ ...forward[0], provider: 'claude' }]
    )).toEqual({ provider: 'codex', reason: 'Explicit request' });
    expect(recommendedVerificationAssignment(
      'Use Codex to implement authentication and Claude to review it.',
      [{ provider: 'claude' }, { provider: 'codex' }],
      [{ ...forward[0], provider: 'codex' }]
    )).toEqual({ provider: 'claude', reason: 'Explicit request' });
    expect(planObjectiveForAgents('Build an accessible frontend form.', [
      { provider: 'codex', profileId: 'backend', instructions: 'Own database migrations and API services.' },
      { provider: 'claude', profileId: 'frontend', instructions: 'Own accessible frontend interfaces.' }
    ])).toMatchObject([{ provider: 'claude', assignmentReason: 'Profile specialty' }]);
    expect(planObjective('Use Cursor Agent to implement the dashboard.', ['claude', 'codex', 'cursor']))
      .toMatchObject([{ provider: 'cursor', role: 'owner', assignmentReason: 'Explicit request' }]);
    expect(recommendedVerificationAssignment(
      'Use Cursor to review the implementation.',
      [{ provider: 'claude' }, { provider: 'cursor' }],
      [{ ...forward[0], provider: 'claude' }]
    )).toEqual({ provider: 'cursor', reason: 'Explicit request' });
  });

  it('supports parallel workstreams and independent audits', () => {
    expect(planObjective('Build API; Build UI', ['claude', 'codex'], 'parallel')).toMatchObject([
      { provider: 'claude', title: 'Build API', role: 'specialist' },
      { provider: 'codex', title: 'Build UI', role: 'specialist' }
    ]);
    expect(planObjective('Find the race condition', ['claude', 'codex'], 'audit')).toMatchObject([
      { title: 'Primary audit', role: 'investigator' },
      { title: 'Second opinion', role: 'investigator' }
    ]);
  });

  it('creates isolated worktrees and launches workers concurrently', async () => {
    const { database, worktrees, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Inspect the project without modifying files',
      providers: ['claude', 'codex'],
      strategy: 'audit',
      concurrency: 2
    });

    expect(created.run).toMatchObject({ status: 'planning', planningProvider: 'claude', planningModel: 'claude-opus-4-1' });
    expect(planner(terminals).args).toContain('plan');
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 2);
    const workerSessions = workers(terminals);
    expect(worktrees.created).toHaveLength(2);
    expect(new Set(workerSessions.map(({ snapshot }) => snapshot.cwd)).size).toBe(2);
    expect(workerSessions.find(({ snapshot }) => snapshot.provider === 'codex')?.args)
      .not.toContain('exec');
    expect(workerSessions.find(({ snapshot }) => snapshot.provider === 'codex')?.args)
      .toContain('--no-alt-screen');
    const claudeNativeSessionId = database.getOrchestration(created.run.id)?.sessions
      ?.find(({ provider }) => provider === 'claude')?.nativeSessionId;
    expect(claudeNativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(workerSessions.find(({ snapshot }) => snapshot.provider === 'claude')?.args)
      .toContain(claudeNativeSessionId);
    expect(terminals.submitted).toHaveLength(2);
    expect(terminals.submitted[0].text).toContain('Relay worker coordinated by Michael');
    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: { status: 'running' },
      tasks: [{ status: 'running' }, { status: 'running' }],
      sessions: [{ status: 'working' }, { status: 'working' }]
    });
    const activeSnapshot = database.getOrchestration(created.run.id)!;
    expect(new Set(activeSnapshot.sessions?.map((session) => session.id)).size).toBe(2);
    expect(activeSnapshot.tasks.map((task) => task.agentSessionId)).toEqual(
      activeSnapshot.sessions?.map((session) => session.id)
    );
    expect(activeSnapshot.sessions?.map((session) => session.terminalId)).toEqual(
      activeSnapshot.tasks.map((task) => task.terminalId)
    );

    const [first, second] = workerSessions.map(({ snapshot }) => snapshot);
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    orchestrator.handleTerminalExit({ id: second.id, exitCode: 0, exitedAt: Date.now() });
    await finishSynthesis(orchestrator, terminals, 'All inspection tasks completed successfully.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    expect(database.getOrchestration(created.run.id)?.tasks.every((task) => task.summary)).toBe(true);
    expect(database.getOrchestration(created.run.id)?.sessions?.every((session) => session.status === 'stopped')).toBe(true);
    expect(database.getOrchestration(created.run.id)?.run.finalSummary).toContain('completed successfully');
    database.close();
  });

  it('runs, follows up, and resumes a Cursor worker in its Relay worktree', async () => {
    const nativeId = '01a057e7-ce82-7031-9fc4-cf3ec5800005';
    const { database, terminals, orchestrator } = fixture(
      undefined,
      async (provider) => provider === 'cursor' ? nativeId : undefined,
      capabilities(['cursor']),
      async (provider) => provider === 'cursor' ? nativeId : undefined,
      async (_provider, _cwd, _nativeSessionId, _startedAt, requiredMarker) =>
        `Clean structured Cursor result.\n${requiredMarker}`
    );
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Use Cursor Agent to implement the settings panel.',
      providers: ['cursor']
    });
    expect(created.run.planningProvider).toBe('cursor');
    expect(planner(terminals).args).toEqual(expect.arrayContaining(['stream-json', 'plan']));
    await finishPlanningWithFallback(orchestrator, terminals);
    const worker = workers(terminals)[0];
    expect(worker.snapshot.provider).toBe('cursor');
    expect(worker.snapshot.cwd).toContain('worktrees');
    expect(worker.args).toEqual(expect.arrayContaining(['--force', '--sandbox', 'enabled']));
    expect(worker.args).toEqual(expect.arrayContaining(['--resume', nativeId]));
    expect(worker.args).not.toContain('--print');
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0]?.nativeSessionId === nativeId);

    const taskPrompt = terminals.submitted.find(({ id }) => id === worker.snapshot.id)?.text ?? '';
    const taskToken = taskPrompt.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    const taskOutput = `Cursor completed the settings panel.\nRELAY_TASK_COMPLETE:${taskToken}`;
    terminals.replayData.set(worker.snapshot.id, taskOutput);
    orchestrator.handleTerminalData({ id: worker.snapshot.id, data: taskOutput, sequence: 1 });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0]?.status === 'idle');
    expect(database.getOrchestration(created.run.id)?.tasks[0].summary).toBe('Clean structured Cursor result.');

    const sessionId = database.getOrchestration(created.run.id)!.sessions![0].id;
    await orchestrator.submitAgentSessionInput({ sessionId, prompt: 'Adjust the spacing.' });
    const followupPrompt = terminals.submitted.at(-1)?.text ?? '';
    const followupToken = followupPrompt.match(/READY:([a-f0-9]+)/)?.[1];
    const followupOutput = `Spacing adjusted.\nRELAY_AGENT_READY:${followupToken}`;
    terminals.replayData.set(worker.snapshot.id, followupOutput);
    orchestrator.handleTerminalData({ id: worker.snapshot.id, data: followupOutput, sequence: 2 });
    await eventually(() => database.getAgentSession(sessionId)?.status === 'idle');

    await orchestrator.stopAgentSession({ sessionId });
    orchestrator.handleTerminalExit({ id: worker.snapshot.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getAgentSession(sessionId)?.status === 'stopped');
    await orchestrator.restartAgentSession({ sessionId });
    expect(workers(terminals).at(-1)?.args).toEqual(expect.arrayContaining(['--resume', nativeId]));
    database.close();
  });

  it('completes interactive workers from protocol markers while keeping their CLIs alive', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build; Verify',
      providers: ['claude', 'codex'],
      strategy: 'parallel',
      concurrency: 2
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 2 && terminals.submitted.length === 2);

    for (const { snapshot } of workers(terminals)) {
      const prompt = terminals.submitted.find(({ id }) => id === snapshot.id)?.text ?? '';
      const token = prompt.match(/COMPLETE:([a-f0-9]+)/)?.[1];
      expect(token).toBeTruthy();
      expect(prompt).not.toContain(`RELAY_TASK_COMPLETE:${token}`);
      const output = `Implemented the assigned work and ran focused checks.\nRELAY_TASK_COMPLETE:${token}`;
      terminals.replayData.set(snapshot.id, output);
      orchestrator.handleTerminalData({ id: snapshot.id, data: output, sequence: 1 });
    }

    await eventually(() => database.getOrchestration(created.run.id)?.tasks.every((task) => task.status === 'completed') === true);
    expect(database.getOrchestration(created.run.id)?.sessions).toEqual(expect.arrayContaining([
      { provider: 'claude', status: 'idle' },
      { provider: 'codex', status: 'idle' }
    ].map((expected) => expect.objectContaining(expected))));
    expect(terminals.stopped).toEqual([]);
    await finishSynthesis(orchestrator, terminals, 'Both interactive workers completed and remain available.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    database.close();
  });

  it('routes an interactive blocker while leaving the worker available for follow-up', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Repair the generated client',
      providers: ['claude']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const prompt = terminals.submitted[0].text;
    const token = prompt.match(/BLOCKED:([a-f0-9]+)/)?.[1];
    const output = `Unable to continue.\nRELAY_TASK_BLOCKED:${token}: Generated SDK is missing.`;
    terminals.replayData.set(worker.id, output);
    orchestrator.handleTerminalData({ id: worker.id, data: output, sequence: 1 });

    await eventually(() => database.getOrchestration(created.run.id)?.tasks[0].status === 'blocked');
    expect(database.getOrchestration(created.run.id)).toMatchObject({
      tasks: [{ blocker: 'Generated SDK is missing.' }],
      sessions: [{ status: 'idle', terminalId: worker.id }]
    });
    expect(terminals.stopped).toEqual([]);
    database.close();
  });

  it('reuses a completed worker for tracked follow-up prompts', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build a reusable module',
      providers: ['claude']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `Module ready.\nRELAY_TASK_COMPLETE:${taskToken}`,
      sequence: 1
    });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].status === 'idle');
    const session = database.getOrchestration(created.run.id)!.sessions![0];

    const active = await orchestrator.submitAgentSessionInput({
      sessionId: session.id,
      prompt: 'Add one focused regression test.'
    });
    expect(active).toMatchObject({ id: session.id, status: 'working', terminalId: worker.id });
    const followupPrompt = terminals.submitted[1].text;
    const followupToken = followupPrompt.match(/READY:([a-f0-9]+)/)?.[1];
    expect(followupPrompt).toContain('Add one focused regression test.');
    expect(followupPrompt).not.toContain(`RELAY_AGENT_READY:${followupToken}`);

    orchestrator.handleTerminalData({
      id: worker.id,
      data: `Regression test added.\nRELAY_AGENT_READY:${followupToken}`,
      sequence: 2
    });
    await eventually(() => database.getAgentSession(session.id)?.status === 'idle');
    expect(database.getAgentSession(session.id)).toMatchObject({
      id: session.id,
      status: 'idle',
      terminalId: worker.id,
      error: undefined
    });
    expect(terminals.stopped).toEqual([]);
    database.close();
  });

  it('reopens stale review, integration, verification, and synthesis after a follow-up changes files', async () => {
    const { database, worktrees, terminals, orchestrator, messages } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build a reusable module',
      providers: ['claude']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `Module ready.\nRELAY_TASK_COMPLETE:${taskToken}`,
      sequence: 1
    });
    await finishSynthesis(orchestrator, terminals, 'The original module is complete.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    const task = database.getOrchestration(created.run.id)!.tasks[0];
    await orchestrator.review({ taskId: task.id, decision: 'accepted' });
    await orchestrator.integrate({ runId: created.run.id });
    const verifying = await orchestrator.verify({ runId: created.run.id, provider: 'codex' });
    terminals.replayData.set(verifying.run.verificationTerminalId!, 'Checks passed.\nRELAY_VERDICT: PASS');
    orchestrator.handleTerminalExit({
      id: verifying.run.verificationTerminalId!,
      exitCode: 0,
      exitedAt: Date.now()
    });
    await eventually(() => database.getOrchestration(created.run.id)?.run.verificationStatus === 'passed');

    const session = database.getOrchestration(created.run.id)!.sessions![0];
    await orchestrator.submitAgentSessionInput({
      sessionId: session.id,
      prompt: 'Add a regression test and update the implementation.'
    });
    await expect(orchestrator.review({ taskId: task.id, decision: 'accepted' }))
      .rejects.toThrow('follow-up to finish');
    await expect(orchestrator.integrate({ runId: created.run.id }))
      .rejects.toThrow('follow-ups to finish');
    await expect(orchestrator.verify({ runId: created.run.id, provider: 'codex' }))
      .rejects.toThrow('follow-ups to finish');
    await expect(orchestrator.cleanup({ runId: created.run.id }))
      .rejects.toThrow('follow-ups to finish');
    worktrees.diffPatch = '+reconciled feature';
    const followupToken = terminals.submitted.at(-1)!.text.match(/READY:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `Regression coverage added.\nRELAY_AGENT_READY:${followupToken}`,
      sequence: 2
    });

    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'summarizing');
    const reconciled = database.getOrchestration(created.run.id)!;
    expect(reconciled.tasks[0]).toMatchObject({
      status: 'completed',
      summary: 'Regression coverage added.',
      reviewStatus: 'pending',
      integrationStatus: 'pending',
      integrationCommit: undefined,
      reviewedAt: undefined,
      integratedAt: undefined
    });
    expect(reconciled.run).toMatchObject({
      integrationStatus: 'pending',
      verificationStatus: 'idle',
      verificationSummary: undefined,
      synthesisStatus: 'running',
      finalSummary: undefined
    });
    expect(messages.at(-1)).toMatchObject({ kind: 'result', taskId: task.id });
    expect(messages.at(-1)?.body).toContain('Review and integration are required again');

    await eventually(() => terminals.spawned.filter(({ snapshot }) => snapshot.role === 'synthesizer').length === 2);
    const revisedSynthesis = terminals.spawned.filter(({ snapshot }) => snapshot.role === 'synthesizer').at(-1)!.snapshot;
    terminals.replayData.set(revisedSynthesis.id, 'The revised module and regression test are ready.');
    orchestrator.handleTerminalExit({ id: revisedSynthesis.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    expect(database.getOrchestration(created.run.id)?.run.finalSummary).toContain('revised module');
    database.close();
  });

  it('reconciles partial work when a follow-up CLI exits before its ready marker', async () => {
    const { database, worktrees, terminals, orchestrator, messages } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Build', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${taskToken}`, sequence: 1 });
    await finishSynthesis(orchestrator, terminals, 'Initial build complete.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    const session = database.getOrchestration(created.run.id)!.sessions![0];

    await orchestrator.submitAgentSessionInput({ sessionId: session.id, prompt: 'Revise the module.' });
    worktrees.diffPatch = '+partial revision';
    terminals.replayData.set(worker.id, 'Updated the module before the provider exited.');
    orchestrator.handleTerminalExit({ id: worker.id, exitCode: 1, exitedAt: Date.now() });

    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'summarizing');
    expect(database.getAgentSession(session.id)).toMatchObject({ status: 'failed' });
    expect(database.getOrchestration(created.run.id)?.tasks[0]).toMatchObject({
      status: 'failed',
      reviewStatus: 'pending',
      integrationStatus: 'pending'
    });
    expect(messages.at(-1)).toMatchObject({ kind: 'blocker' });
    database.close();
  });

  it('preserves accepted and verified results when a follow-up is informational only', async () => {
    const { database, terminals, orchestrator, messages } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Inspect', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${taskToken}`, sequence: 1 });
    await finishSynthesis(orchestrator, terminals, 'Inspection complete.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    const task = database.getOrchestration(created.run.id)!.tasks[0];
    await orchestrator.review({ taskId: task.id, decision: 'accepted' });
    await orchestrator.integrate({ runId: created.run.id });
    const before = database.getOrchestration(created.run.id)!;
    const session = before.sessions![0];

    await orchestrator.submitAgentSessionInput({ sessionId: session.id, prompt: 'Explain the design.' });
    const token = terminals.submitted.at(-1)!.text.match(/READY:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `The module has one public boundary.\nRELAY_AGENT_READY:${token}`,
      sequence: 2
    });
    await eventually(() => database.getAgentSession(session.id)?.status === 'idle');

    const after = database.getOrchestration(created.run.id)!;
    expect(after.run).toMatchObject({
      status: 'completed',
      integrationStatus: 'integrated',
      finalSummary: before.run.finalSummary
    });
    expect(after.tasks[0]).toMatchObject({
      reviewStatus: 'accepted',
      integrationStatus: 'integrated',
      integrationCommit: before.tasks[0].integrationCommit
    });
    expect(messages.at(-1)).toMatchObject({ kind: 'status' });
    expect(messages.at(-1)?.body).toContain('without changing the worktree');
    expect(terminals.spawned.filter(({ snapshot }) => snapshot.role === 'synthesizer')).toHaveLength(1);
    database.close();
  });

  it('resolves a blocked task through its live session even when no files change', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Inspect', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/BLOCKED:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `Need a decision.\nRELAY_TASK_BLOCKED:${taskToken}: Choose a format.`,
      sequence: 1
    });
    await finishSynthesis(orchestrator, terminals, 'The task needs a format decision.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'blocked');
    const session = database.getOrchestration(created.run.id)!.sessions![0];

    await orchestrator.submitAgentSessionInput({ sessionId: session.id, prompt: 'Use JSON.' });
    const token = terminals.submitted.at(-1)!.text.match(/READY:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: worker.id,
      data: `JSON selected.\nRELAY_AGENT_READY:${token}`,
      sequence: 2
    });

    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'summarizing');
    expect(database.getOrchestration(created.run.id)?.tasks[0]).toMatchObject({
      status: 'completed',
      blocker: undefined,
      summary: 'JSON selected.',
      reviewStatus: 'pending'
    });
    database.close();
  });

  it('stops and resumes a durable worker without changing its Relay identity', async () => {
    const nativeSessionId = '01a057e7-ce82-7031-9fc4-cf3ec5800004';
    const { database, terminals, orchestrator } = fixture(undefined, async () => nativeSessionId);
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Inspect the project',
      providers: ['codex']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const original = workers(terminals)[0].snapshot;
    const token = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({
      id: original.id,
      data: `Inspection complete.\nRELAY_TASK_COMPLETE:${token}`,
      sequence: 1
    });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].status === 'idle');
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].nativeSessionId === nativeSessionId);
    const session = database.getOrchestration(created.run.id)!.sessions![0];

    await expect(orchestrator.stopAgentSession({ sessionId: session.id })).resolves.toEqual({ ok: true });
    expect(database.getAgentSession(session.id)?.status).toBe('stopping');
    expect(terminals.stopped).toContain(original.id);
    await expect(orchestrator.restartAgentSession({ sessionId: session.id }))
      .rejects.toThrow('live session');
    orchestrator.handleTerminalExit({ id: original.id, exitCode: 143, exitedAt: Date.now() });
    await eventually(() => database.getAgentSession(session.id)?.status === 'stopped');
    expect(database.getAgentSession(session.id)?.error).toBeUndefined();

    const restarted = await orchestrator.restartAgentSession({ sessionId: session.id });
    expect(restarted).toMatchObject({ id: session.id, status: 'idle', worktreePath: session.worktreePath });
    expect(restarted.terminalId).not.toBe(original.id);
    const resumedTerminal = terminals.spawned.find(({ snapshot }) => snapshot.id === restarted.terminalId);
    expect(resumedTerminal?.args?.slice(-2)).toEqual(['resume', nativeSessionId]);
    expect(database.getOrchestrationTask(session.initialTaskId)?.terminalId).toBe(restarted.terminalId);
    database.close();
  });

  it('reconciles changed follow-up work as stopped when the user stops its live session', async () => {
    const { database, worktrees, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Build', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${taskToken}`, sequence: 1 });
    await finishSynthesis(orchestrator, terminals, 'Initial build complete.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    const session = database.getOrchestration(created.run.id)!.sessions![0];

    await orchestrator.submitAgentSessionInput({ sessionId: session.id, prompt: 'Change the implementation.' });
    worktrees.diffPatch = '+partial user-stopped change';
    await expect(orchestrator.stopAgentSession({ sessionId: session.id })).resolves.toEqual({ ok: true });
    expect(database.getAgentSession(session.id)?.status).toBe('stopping');
    orchestrator.handleTerminalExit({ id: worker.id, exitCode: 1, exitedAt: Date.now() });

    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'summarizing');
    expect(database.getAgentSession(session.id)).toMatchObject({ status: 'stopped', error: undefined });
    expect(database.getOrchestration(created.run.id)?.tasks[0]).toMatchObject({
      status: 'stopped',
      reviewStatus: 'pending',
      integrationStatus: 'pending'
    });
    database.close();
  });

  it('closes durable sessions when their stopped worktree is removed', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Build', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const taskToken = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${taskToken}`, sequence: 1 });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].status === 'idle');
    const snapshot = database.getOrchestration(created.run.id)!;
    const session = snapshot.sessions![0];
    const worktreeId = session.worktreeId!;
    expect(orchestrator.canRemoveWorktree(worktreeId)).toMatchObject({ ok: false });

    await orchestrator.stopAgentSession({ sessionId: session.id });
    expect(orchestrator.canRemoveWorktree(worktreeId)).toMatchObject({ ok: false });
    orchestrator.handleTerminalExit({ id: worker.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getAgentSession(session.id)?.status === 'stopped');
    expect(orchestrator.canRemoveWorktree(worktreeId)).toEqual({ ok: true });
    await orchestrator.finalizeWorktreeRemoval(worktreeId);

    expect(database.getAgentSession(session.id)).toMatchObject({
      status: 'closed',
      worktreeId: undefined,
      worktreePath: undefined,
      terminalId: undefined
    });
    expect(database.getOrchestrationTask(session.initialTaskId)).toMatchObject({
      worktreeId: undefined,
      worktreePath: undefined,
      terminalId: undefined
    });
    await expect(orchestrator.restartAgentSession({ sessionId: session.id }))
      .rejects.toThrow('cannot be restarted');
    database.close();
  });

  it('restores an idle session when a follow-up cannot be submitted', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Build', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const token = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${token}`, sequence: 1 });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].status === 'idle');
    const session = database.getOrchestration(created.run.id)!.sessions![0];
    terminals.submitError = 'PTY input failed.';

    await expect(orchestrator.submitAgentSessionInput({ sessionId: session.id, prompt: 'Change it.' }))
      .rejects.toThrow('PTY input failed.');
    expect(database.getAgentSession(session.id)).toMatchObject({ status: 'idle', error: 'PTY input failed.' });
    database.close();
  });

  it('quarantines a recovered session when its managed worktree is missing', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Inspect', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const session = database.getOrchestration(created.run.id)!.sessions![0];
    session.status = 'resumable';
    session.terminalId = undefined;
    database.upsertAgentSession(session);
    rmSync(session.worktreePath!, { recursive: true, force: true });

    expect(orchestrator.reconcileRecoveredSessions()).toBe(1);
    expect(database.getAgentSession(session.id)).toMatchObject({
      status: 'failed',
      terminalId: undefined,
      error: 'The agent worktree is missing. Restore it before resuming this session.'
    });
    await expect(orchestrator.restartAgentSession({ sessionId: session.id }))
      .rejects.toThrow('worktree is missing');
    database.close();
  });

  it('recovers a persisted session after Relay restarts and resumes its exact conversation', async () => {
    const { database, worktrees, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({ repoPath: '/repo', objective: 'Build', providers: ['claude'] });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1 && terminals.submitted.length === 1);
    const worker = workers(terminals)[0].snapshot;
    const token = terminals.submitted[0].text.match(/COMPLETE:([a-f0-9]+)/)?.[1];
    orchestrator.handleTerminalData({ id: worker.id, data: `Done\nRELAY_TASK_COMPLETE:${token}`, sequence: 1 });
    await eventually(() => database.getOrchestration(created.run.id)?.sessions?.[0].status === 'idle');
    const beforeRestart = database.getOrchestration(created.run.id)!.sessions![0];
    expect(beforeRestart.nativeSessionId).toBeTruthy();
    orchestrator.shutdown();

    database.close();
    database.open();
    const resumedTerminals = new FakeTerminals();
    const restarted = new Orchestrator({
      database,
      logger: pino({ enabled: false }),
      worktrees,
      terminals: resumedTerminals,
      detectProviders: async () => capabilities()
    });
    expect(restarted.recover()).toBeGreaterThan(0);
    expect(database.getAgentSession(beforeRestart.id)).toMatchObject({
      status: 'resumable',
      terminalId: undefined,
      nativeSessionId: beforeRestart.nativeSessionId
    });

    const resumed = await restarted.restartAgentSession({ sessionId: beforeRestart.id });
    expect(resumed).toMatchObject({ id: beforeRestart.id, status: 'idle', error: undefined });
    expect(resumedTerminals.spawned[0].args).toContain('--resume');
    expect(resumedTerminals.spawned[0].args).toContain(beforeRestart.nativeSessionId);
    database.close();
  });

  it('fails safely when the initial interactive prompt cannot be submitted', async () => {
    const { database, terminals, orchestrator } = fixture();
    terminals.submitError = 'PTY input failed.';
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build one thing',
      providers: ['codex']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => database.getOrchestration(created.run.id)?.tasks[0].status === 'failed');

    expect(database.getOrchestration(created.run.id)).toMatchObject({
      tasks: [{ status: 'failed', error: 'PTY input failed.' }],
      sessions: [{ status: 'failed', error: 'PTY input failed.' }]
    });
    expect(terminals.stopped).toEqual([workers(terminals)[0].snapshot.id]);
    database.close();
  });

  it('materializes a provider-neutral model-authored plan', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Use Codex to implement a secure settings screen and Claude to review it.',
      providers: ['claude', 'codex'],
      concurrency: 2
    });
    const planning = planner(terminals);
    terminals.replayData.set(planning.snapshot.id, JSON.stringify({
      summary: 'Codex owns cohesive delivery; Relay verifies after integration.',
      tasks: [
        {
          title: 'Build settings UI',
          role: 'owner',
          deliverable: 'Working settings screen',
          instructions: 'Implement and test the settings screen and its state handling.',
          provider: 'codex',
          assignmentReason: 'Explicit request'
        }
      ]
    }));
    orchestrator.handleTerminalExit({ id: planning.snapshot.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => workers(terminals).length === 1);

    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: {
        planningSource: 'model',
        planningSummary: 'Codex owns cohesive delivery; Relay verifies after integration.',
        recommendedVerificationProvider: 'claude',
        status: 'running'
      },
      tasks: [
        { title: 'Build settings UI', provider: 'codex', status: 'running', assignmentReason: 'Explicit request' }
      ]
    });
    database.close();
  });

  it('runs one model-authored mixed team across Claude, Codex, and Cursor', async () => {
    const { database, terminals, orchestrator } = fixture(
      undefined,
      undefined,
      capabilities(['claude', 'codex', 'cursor'])
    );
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Create three independent compatibility fixtures with Claude, Codex, and Cursor.',
      strategy: 'parallel',
      providers: ['cursor', 'claude', 'codex'],
      concurrency: 3
    });
    const planning = planner(terminals);
    terminals.replayData.set(planning.snapshot.id, JSON.stringify({
      summary: 'Three isolated fixtures exercise the complete provider pool.',
      tasks: [
        { title: 'Claude fixture', role: 'builder', deliverable: 'claude.txt', instructions: 'Create only claude.txt.', provider: 'claude', assignmentReason: 'Independent fixture' },
        { title: 'Cursor fixture', role: 'specialist', deliverable: 'cursor.txt', instructions: 'Create only cursor.txt.', provider: 'cursor', assignmentReason: 'Independent fixture' },
        { title: 'Codex fixture', role: 'builder', deliverable: 'codex.txt', instructions: 'Create only codex.txt.', provider: 'codex', assignmentReason: 'Independent fixture' }
      ]
    }));
    orchestrator.handleTerminalExit({ id: planning.snapshot.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => workers(terminals).length === 3);

    expect(workers(terminals).map(({ snapshot }) => snapshot.provider).sort()).toEqual(['claude', 'codex', 'cursor']);
    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: { planningSource: 'model', status: 'running' },
      tasks: [
        { provider: 'claude', status: 'running' },
        { provider: 'cursor', status: 'running' },
        { provider: 'codex', status: 'running' }
      ]
    });
    database.close();
  });

  it('stops a timed-out planner and continues with the safe fallback', async () => {
    const { database, terminals, orchestrator } = fixture({ planning: 10 });
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build a small feature',
      providers: ['claude']
    });
    const planning = planner(terminals).snapshot;
    await eventually(() => terminals.stopped.includes(planning.id));
    orchestrator.handleTerminalExit({ id: planning.id, exitCode: 143, exitedAt: Date.now() });
    await eventually(() => workers(terminals).length === 1);

    expect(database.getOrchestration(created.run.id)?.run).toMatchObject({
      planningSource: 'fallback',
      planningError: 'Planning timed out after 5 minutes.'
    });
    orchestrator.shutdown();
    database.close();
  });

  it('runs reusable profiles from a saved team template', async () => {
    const { database, terminals, orchestrator } = fixture();
    const now = Date.now();
    database.upsertAgentProfile({
      id: 'profile-avery',
      name: 'Avery',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      instructions: 'Own the frontend and accessibility.',
      avatarSeed: 'avery',
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
    database.upsertAgentProfile({
      id: 'profile-morgan',
      name: 'Morgan',
      provider: 'claude',
      model: null,
      instructions: 'Own focused tests and review.',
      avatarSeed: 'morgan',
      enabled: true,
      createdAt: now,
      updatedAt: now
    });
    database.upsertOrchestrationTemplate({
      id: 'template-feature',
      name: 'Feature team',
      objective: 'Build a feature.',
      strategy: 'parallel',
      profileIds: ['profile-avery', 'profile-morgan'],
      concurrency: 2,
      createdAt: now,
      updatedAt: now
    });

    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build the extension library.',
      templateId: 'template-feature'
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 2);
    const planned = database.getOrchestration(created.run.id)!;

    expect(planned.run).toMatchObject({ templateId: 'template-feature', strategy: 'parallel', concurrency: 2 });
    expect(planned.tasks).toMatchObject([
      { profileId: 'profile-avery', agentName: 'Avery', provider: 'claude', model: 'claude-sonnet-4-5' },
      { profileId: 'profile-morgan', agentName: 'Morgan', provider: 'claude' }
    ]);
    expect(workers(terminals).map(({ snapshot }) => snapshot.name)).toEqual(['Avery', 'Morgan']);
    expect(workers(terminals)[0].args).toContain('claude-sonnet-4-5');
    expect(terminals.submitted.find(({ id }) => id === workers(terminals)[0].snapshot.id)?.text)
      .toContain('Own the frontend and accessibility.');
    database.close();
  });

  it('respects concurrency and starts the next queued task after exit', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build; Verify',
      providers: ['claude', 'codex'],
      strategy: 'parallel',
      concurrency: 1
    });

    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1);
    const first = workers(terminals)[0].snapshot;
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => workers(terminals).length === 2);
    expect(database.getOrchestration(created.run.id)?.tasks.map((task) => task.status)).toEqual([
      'completed',
      'running'
    ]);
    database.close();
  });

  it('stops active workers and permits retry', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build one thing',
      providers: ['codex']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1);
    const first = workers(terminals)[0].snapshot;

    await expect(orchestrator.stop(created.run.id)).resolves.toEqual({ ok: true });
    expect(terminals.stopped).toEqual([first.id]);
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'stopped');

    const task = database.getOrchestration(created.run.id)!.tasks[0];
    const originalSessionId = task.agentSessionId;
    await expect(orchestrator.retry({ taskId: task.id })).resolves.toEqual({ ok: true });
    await eventually(() => workers(terminals).length === 2);
    expect(database.getOrchestration(created.run.id)?.run.status).toBe('running');
    expect(database.getOrchestration(created.run.id)?.tasks[0].agentSessionId).toBe(originalSessionId);
    expect(database.listAgentSessions(created.run.id)).toHaveLength(1);
    database.close();
  });

  it('reviews, integrates in task order, verifies, and cleans worktrees', async () => {
    const { database, worktrees, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build; Verify',
      strategy: 'parallel',
      providers: ['claude', 'codex'],
      concurrency: 2
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 2);
    for (const { snapshot } of workers(terminals).slice(0, 2)) {
      orchestrator.handleTerminalExit({ id: snapshot.id, exitCode: 0, exitedAt: Date.now() });
    }
    await finishSynthesis(orchestrator, terminals, 'The feature and validation work are ready for review.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    const completed = database.getOrchestration(created.run.id)!;

    await expect(orchestrator.diff({ taskId: completed.tasks[0].id }))
      .resolves.toMatchObject({ taskId: completed.tasks[0].id, additions: 2 });
    for (const task of completed.tasks) {
      await orchestrator.review({ taskId: task.id, decision: 'accepted' });
    }
    const integrated = await orchestrator.integrate({ runId: created.run.id });

    expect(worktrees.integrated).toEqual(worktrees.created.map((worktree) => worktree.id));
    expect(integrated.run.integrationStatus).toBe('integrated');
    expect(integrated.tasks.map((task) => task.integrationCommit)).toEqual(['commit-1', 'commit-2']);

    const verifying = await orchestrator.verify({ runId: created.run.id });
    expect(verifying.run).toMatchObject({
      verificationStatus: 'running',
      verificationProvider: integrated.run.recommendedVerificationProvider
    });
    expect(terminals.spawned.at(-1)?.snapshot.role).toBe('verifier');
    expect(terminals.spawned.at(-1)?.args?.join(' ')).toContain('read-only');
    terminals.replayData.set(
      verifying.run.verificationTerminalId!,
      'All project checks passed.\nRELAY_VERDICT: PASS'
    );
    orchestrator.handleTerminalExit({
      id: verifying.run.verificationTerminalId!,
      exitCode: 0,
      exitedAt: Date.now()
    });
    await eventually(() => database.getOrchestration(created.run.id)?.run.verificationStatus === 'passed');

    const restartedVerification = await orchestrator.verify({ runId: created.run.id, provider: 'claude' });
    const restartedTerminalId = restartedVerification.run.verificationTerminalId!;
    await expect(orchestrator.stop(created.run.id)).resolves.toEqual({ ok: true });
    expect(terminals.stopped).toContain(restartedTerminalId);
    expect(database.getOrchestration(created.run.id)?.run).toMatchObject({
      verificationStatus: 'failed',
      verificationError: 'Verification stopped by user.'
    });

    const cleaned = await orchestrator.cleanup({ runId: created.run.id });
    expect(worktrees.removed).toEqual(worktrees.created.map((worktree) => worktree.id));
    expect(cleaned.tasks.every((task) => !task.worktreeId)).toBe(true);
    expect(cleaned.sessions?.every((session) => session.status === 'closed')).toBe(true);
    database.close();
  });

  it('requires an explicit verifier verdict and preserves its failure reason', () => {
    expect(verificationVerdict({ data: '18 tests passed\nRELAY_VERDICT: PASS', lastSequence: 1 }))
      .toEqual({ status: 'passed' });
    expect(verificationVerdict({ data: 'npm test failed\nRELAY_VERDICT: FAIL - two tests failed', lastSequence: 1 }))
      .toEqual({ status: 'failed', reason: 'two tests failed' });
    expect(verificationVerdict({ data: 'Looks fine.', lastSequence: 1 }))
      .toEqual({ status: 'failed', reason: 'Verifier did not return a RELAY_VERDICT marker.' });
  });

  it('routes worker blockers through the hive and creates an approved replacement run', async () => {
    const { database, terminals, orchestrator, messages } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Repair the failing build',
      providers: ['claude']
    });
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 1);
    const worker = workers(terminals)[0].snapshot;
    terminals.replayData.set(worker.id, 'I could not locate the generated SDK.\nRELAY_BLOCKER: Generated SDK is missing.');
    orchestrator.handleTerminalExit({ id: worker.id, exitCode: 0, exitedAt: Date.now() });
    await finishSynthesis(orchestrator, terminals, 'The run is blocked because the generated SDK is missing.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'blocked');

    expect(database.getOrchestration(created.run.id)?.tasks[0]).toMatchObject({
      status: 'blocked',
      blocker: 'Generated SDK is missing.'
    });
    expect(messages.map((message) => message.kind)).toEqual(expect.arrayContaining(['status', 'blocker', 'summary']));

    const replacement = await orchestrator.replan({ runId: created.run.id });
    expect(replacement.run).toMatchObject({
      status: 'planning',
      parentRunId: created.run.id,
      planningProviders: ['claude']
    });
    const nextPlanner = terminals.spawned.filter(({ snapshot }) => snapshot.role === 'planner').at(-1)!;
    expect(nextPlanner.args?.at(-1)).toContain('Previous run evidence');
    expect(messages.at(-1)).toMatchObject({ kind: 'replan', runId: created.run.id });
    database.close();
  });

  it('re-plans integration conflicts with the conflict evidence', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build two independent formatter utilities',
      providers: ['claude', 'codex']
    });
    const conflicted = database.getOrchestration(created.run.id)!;
    conflicted.run.status = 'completed';
    conflicted.run.integrationStatus = 'conflict';
    conflicted.run.integrationError = 'Conflicts in README.md';
    database.updateOrchestrationRun(conflicted.run);

    const replacement = await orchestrator.replan({ runId: created.run.id });
    expect(replacement.run).toMatchObject({
      status: 'planning',
      parentRunId: created.run.id,
      planningProviders: ['claude', 'codex']
    });
    expect(replacement.run.replanContext).toContain('Integration: Conflicts in README.md');
    expect(terminals.spawned.filter(({ snapshot }) => snapshot.role === 'planner').at(-1)?.args?.at(-1))
      .toContain('Integration: Conflicts in README.md');
    database.close();
  });
});

function capabilities(ids: ProviderId[] = ['claude', 'codex']): ProviderCapability[] {
  return ids.map((id) => ({
    id,
    label: id,
    command: id,
    available: true,
    executablePath: `/bin/${id}`,
    version: '1.0.0',
    error: null
  }));
}

function planner(terminals: FakeTerminals): FakeTerminals['spawned'][number] {
  const session = terminals.spawned.find(({ snapshot }) => snapshot.role === 'planner');
  if (!session) throw new Error('Planner terminal was not started.');
  return session;
}

function workers(terminals: FakeTerminals): FakeTerminals['spawned'] {
  return terminals.spawned.filter(({ snapshot }) => snapshot.role === 'worker');
}

function synthesizer(terminals: FakeTerminals): FakeTerminals['spawned'][number] | undefined {
  return terminals.spawned.find(({ snapshot }) => snapshot.role === 'synthesizer');
}

async function finishSynthesis(
  orchestrator: Orchestrator,
  terminals: FakeTerminals,
  summary: string
): Promise<void> {
  await eventually(() => Boolean(synthesizer(terminals)));
  const session = synthesizer(terminals)!.snapshot;
  terminals.replayData.set(session.id, summary);
  orchestrator.handleTerminalExit({ id: session.id, exitCode: 0, exitedAt: Date.now() });
}

async function finishPlanningWithFallback(orchestrator: Orchestrator, terminals: FakeTerminals): Promise<void> {
  const session = planner(terminals).snapshot;
  orchestrator.handleTerminalExit({ id: session.id, exitCode: 1, exitedAt: Date.now() });
  await eventually(() => workers(terminals).length > 0);
}

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Condition was not met in time.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
