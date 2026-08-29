import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProviderCapability,
  ProviderId,
  TerminalReplay,
  TerminalSnapshot,
  TaskDiffSnapshot,
  WorktreeSnapshot
} from '../src/shared/contracts';
import { RelayDatabase } from '../src/main/database';
import { planObjective, RehanOrchestrator } from '../src/main/orchestrator';

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

  async spawn(request: { provider: ProviderId; name?: string; cwd: string; args?: string[] }): Promise<TerminalSnapshot> {
    const snapshot: TerminalSnapshot = {
      id: `terminal-${this.spawned.length + 1}`,
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
    return { data: `summary for ${id}`, lastSequence: 1 };
  }
}

function fixture(): {
  database: RelayDatabase;
  worktrees: FakeWorktrees;
  terminals: FakeTerminals;
  orchestrator: RehanOrchestrator;
} {
  const root = mkdtempSync(join(tmpdir(), 'relay-orchestrator-test-'));
  temporaryDirectories.push(root);
  const database = new RelayDatabase(join(root, 'relay.db'));
  database.open();
  const worktrees = new FakeWorktrees();
  const terminals = new FakeTerminals();
  const orchestrator = new RehanOrchestrator({
    database,
    logger: pino({ enabled: false }),
    worktrees,
    terminals,
    detectProviders: async () => capabilities()
  });
  return { database, worktrees, terminals, orchestrator };
}

describe('RehanOrchestrator', () => {
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

    await eventually(() => terminals.spawned.length === 2);
    expect(worktrees.created).toHaveLength(2);
    expect(new Set(terminals.spawned.map(({ snapshot }) => snapshot.cwd)).size).toBe(2);
    expect(terminals.spawned[0].args?.join(' ')).toContain('Relay worker coordinated by Michael');
    expect(terminals.spawned.find(({ snapshot }) => snapshot.provider === 'codex')?.args?.slice(0, 3))
      .toEqual(['--ask-for-approval', 'never', 'exec']);
    expect(database.getOrchestration(created.run.id)).toMatchObject({
      run: { status: 'running' },
      tasks: [{ status: 'running' }, { status: 'running' }]
    });

    const [first, second] = terminals.spawned.map(({ snapshot }) => snapshot);
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    orchestrator.handleTerminalExit({ id: second.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'completed');
    expect(database.getOrchestration(created.run.id)?.tasks.every((task) => task.summary)).toBe(true);
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

    await eventually(() => terminals.spawned.length === 1);
    const first = terminals.spawned[0].snapshot;
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => terminals.spawned.length === 2);
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
    await eventually(() => terminals.spawned.length === 1);
    const first = terminals.spawned[0].snapshot;

    await expect(orchestrator.stop(created.run.id)).resolves.toEqual({ ok: true });
    expect(terminals.stopped).toEqual([first.id]);
    orchestrator.handleTerminalExit({ id: first.id, exitCode: 0, exitedAt: Date.now() });
    await eventually(() => database.getOrchestration(created.run.id)?.run.status === 'stopped');

    const task = database.getOrchestration(created.run.id)!.tasks[0];
    await expect(orchestrator.retry({ taskId: task.id })).resolves.toEqual({ ok: true });
    await eventually(() => terminals.spawned.length === 2);
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
    await eventually(() => terminals.spawned.length === 2);
    for (const { snapshot } of terminals.spawned.slice(0, 2)) {
      orchestrator.handleTerminalExit({ id: snapshot.id, exitCode: 0, exitedAt: Date.now() });
    }
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

async function eventually(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Condition was not met in time.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
