import { mkdtempSync, rmSync } from 'node:fs';
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
      path: `/worktrees/${request.name}`,
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
      patch: '+feature',
      truncated: false
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

  replay(id: string): TerminalReplay {
    return { data: this.replayData.get(id) ?? `summary for ${id}`, lastSequence: 1 };
  }
}

function fixture(phaseTimeouts?: { planning?: number; worker?: number; synthesis?: number; verification?: number }): {
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
  const worktrees = new FakeWorktrees();
  const terminals = new FakeTerminals();
  const messages: HiveCoordinationMessage[] = [];
  const orchestrator = new Orchestrator({
    database,
    logger: pino({ enabled: false }),
    worktrees,
    terminals,
    detectProviders: async () => capabilities(),
    getOrchestratorConfig: () => ({ provider: 'claude', model: 'claude-opus-4-1' }),
    onCoordinationMessage: (message) => messages.push(message),
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
  it('decomposes one objective across Claude and Codex', () => {
    expect(planObjective('Build authentication', ['claude', 'codex'])).toMatchObject([
      { provider: 'claude', role: 'builder', deliverable: 'Working implementation' },
      { provider: 'codex', role: 'reviewer', deliverable: 'Tests and review' }
    ]);
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
      concurrency: 2
    });

    expect(created.run).toMatchObject({ status: 'planning', planningProvider: 'claude', planningModel: 'claude-opus-4-1' });
    expect(planner(terminals).args).toContain('plan');
    await finishPlanningWithFallback(orchestrator, terminals);
    await eventually(() => workers(terminals).length === 2);
    const workerSessions = workers(terminals);
    expect(worktrees.created).toHaveLength(2);
    expect(new Set(workerSessions.map(({ snapshot }) => snapshot.cwd)).size).toBe(2);
    expect(workerSessions[0].args?.join(' ')).toContain('Relay worker coordinated by Michael');
    expect(workerSessions.find(({ snapshot }) => snapshot.provider === 'codex')?.args?.slice(0, 3))
      .toEqual(['--ask-for-approval', 'never', 'exec']);
    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: { status: 'running' },
      tasks: [{ status: 'running' }, { status: 'running' }]
    });

    const [first, second] = workerSessions.map(({ snapshot }) => snapshot);
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    orchestrator.handleTerminalExit({ id: second.id, exitCode: 0, exitedAt: Date.now() });
    await finishSynthesis(orchestrator, terminals, 'All inspection tasks completed successfully.');
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    expect(database.getOrchestration(created.run.id)?.tasks.every((task) => task.summary)).toBe(true);
    expect(database.getOrchestration(created.run.id)?.run.finalSummary).toContain('completed successfully');
    database.close();
  });

  it('materializes a valid model-authored plan', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build a secure settings screen',
      providers: ['claude', 'codex'],
      concurrency: 2
    });
    const planning = planner(terminals);
    terminals.replayData.set(planning.snapshot.id, JSON.stringify({
      summary: 'Separate implementation from independent validation.',
      tasks: [
        {
          title: 'Build settings UI',
          role: 'builder',
          deliverable: 'Working settings screen',
          instructions: 'Implement the settings screen and its state handling.',
          provider: 'claude'
        },
        {
          title: 'Validate settings',
          role: 'reviewer',
          deliverable: 'Focused tests and review',
          instructions: 'Add focused tests and inspect accessibility and unsafe state transitions.',
          provider: 'codex'
        }
      ]
    }));
    orchestrator.handleTerminalExit({ id: planning.snapshot.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => workers(terminals).length === 2);

    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: {
        planningSource: 'model',
        planningSummary: 'Separate implementation from independent validation.',
        status: 'running'
      },
      tasks: [
        { title: 'Build settings UI', provider: 'claude', status: 'running' },
        { title: 'Validate settings', provider: 'codex', status: 'running' }
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
    expect(workers(terminals)[0].args?.at(-1)).toContain('Own the frontend and accessibility.');
    database.close();
  });

  it('respects concurrency and starts the next queued task after exit', async () => {
    const { database, terminals, orchestrator } = fixture();
    const created = await orchestrator.create({
      repoPath: '/repo',
      objective: 'Build; Verify',
      providers: ['claude', 'codex'],
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
    await expect(orchestrator.retry({ taskId: task.id })).resolves.toEqual({ ok: true });
    await eventually(() => workers(terminals).length === 2);
    expect(database.getOrchestration(created.run.id)?.run.status).toBe('running');
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

    const verifying = await orchestrator.verify({ runId: created.run.id, provider: 'codex' });
    expect(verifying.run).toMatchObject({ verificationStatus: 'running', verificationProvider: 'codex' });
    expect(terminals.spawned.at(-1)?.args).toContain('read-only');
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

    const cleaned = await orchestrator.cleanup({ runId: created.run.id });
    expect(worktrees.removed).toEqual(worktrees.created.map((worktree) => worktree.id));
    expect(cleaned.tasks.every((task) => !task.worktreeId)).toBe(true);
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
    expect(replacement.run).toMatchObject({ status: 'planning', parentRunId: created.run.id });
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
    expect(replacement.run).toMatchObject({ status: 'planning', parentRunId: created.run.id });
    expect(replacement.run.replanContext).toContain('Integration: Conflicts in README.md');
    expect(terminals.spawned.filter(({ snapshot }) => snapshot.role === 'planner').at(-1)?.args?.at(-1))
      .toContain('Integration: Conflicts in README.md');
    database.close();
  });
});

function capabilities(): ProviderCapability[] {
  return (['claude', 'codex'] as const).map((id) => ({
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
