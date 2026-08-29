import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayDatabase } from '../src/main/database';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabase(): RelayDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'relay-db-test-'));
  temporaryDirectories.push(directory);
  return new RelayDatabase(join(directory, 'relay.db'));
}

describe('RelayDatabase', () => {
  it('opens and applies every migration', () => {
    const database = temporaryDatabase();
    database.open();

    expect(database.health()).toMatchObject({
      open: true,
      schemaVersion: 8
    });

    database.close();
    expect(database.health().open).toBe(false);
  });

  it('persists values and append-only events across reopen', () => {
    const database = temporaryDatabase();
    database.open();
    database.setValue('foundation', { ready: true });
    const eventId = database.appendEvent('test.completed', { ok: true });
    database.close();

    database.open();
    expect(database.getValue('foundation')).toEqual({ ready: true });
    expect(eventId).toBe(1);
    database.close();
  });

  it('pages and filters the activity ledger', () => {
    const database = temporaryDatabase();
    database.open();
    database.appendEvent('app.started', { version: '1.0.0' });
    database.appendEvent('worktree.created', { branch: 'relay/a' });
    database.appendEvent('orchestration.created', { runId: 'run-1' });
    database.appendEvent('terminal.started', { terminalId: 'terminal-1' });

    expect(database.countEvents()).toBe(4);
    const first = database.listEvents({ limit: 2 });
    expect(first.events.map(({ type }) => type)).toEqual(['terminal.started', 'orchestration.created']);
    expect(first.hasMore).toBe(true);
    expect(database.listEvents({ beforeId: first.nextBeforeId, limit: 2 }).events.map(({ type }) => type))
      .toEqual(['worktree.created', 'app.started']);
    expect(database.listEvents({ category: 'worktree' }).events).toMatchObject([
      { type: 'worktree.created', payload: { branch: 'relay/a' } }
    ]);
    expect(database.listEvents({ category: 'system' }).events.map(({ type }) => type)).toEqual(['app.started']);
    database.close();
  });

  it('is safe to open and close more than once', () => {
    const database = temporaryDatabase();
    database.open();
    database.open();
    database.close();
    database.close();

    expect(database.health().open).toBe(false);
  });

  it('persists managed worktree records', () => {
    const database = temporaryDatabase();
    database.open();
    const record = {
      id: 'worktree-1',
      repoRoot: '/tmp/project',
      path: '/tmp/worktrees/agent-1',
      branch: 'relay/agent-1',
      baseBranch: 'main',
      createdAt: 100,
      updatedAt: 100
    };

    database.upsertWorktree(record);
    expect(database.getWorktree(record.id)).toEqual(record);
    expect(database.listWorktrees(record.repoRoot)).toEqual([record]);
    expect(database.deleteWorktree(record.id)).toBe(true);
    expect(database.getWorktree(record.id)).toBeUndefined();
    database.close();
  });

  it('persists reusable agent profiles and orchestration templates', () => {
    const database = temporaryDatabase();
    database.open();
    database.upsertAgentProfile({
      id: 'profile-frontend',
      name: 'Avery',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      instructions: 'Own the renderer.',
      avatarSeed: 'avery',
      enabled: true,
      createdAt: 100,
      updatedAt: 100
    });
    database.upsertOrchestrationTemplate({
      id: 'template-feature',
      name: 'Feature team',
      objective: 'Build and verify the feature.',
      strategy: 'balanced',
      profileIds: ['profile-frontend'],
      concurrency: 1,
      createdAt: 100,
      updatedAt: 100
    });

    expect(database.listAgentProfiles()).toMatchObject([{ name: 'Avery', enabled: true }]);
    expect(database.getOrchestrationTemplate('template-feature')).toMatchObject({
      name: 'Feature team',
      profileIds: ['profile-frontend']
    });
    expect(database.deleteOrchestrationTemplate('template-feature')).toBe(true);
    expect(database.deleteAgentProfile('profile-frontend')).toBe(true);
    database.close();
  });

  it('recovers an interrupted model-planning run without any tasks', () => {
    const database = temporaryDatabase();
    database.open();
    database.createOrchestration({
      run: {
        id: 'run-planning',
        objective: 'Plan the feature',
        repoRoot: '/tmp/project',
        baseBranch: 'main',
        status: 'planning',
        strategy: 'balanced',
        concurrency: 2,
        planningProvider: 'claude',
        planningTerminalId: 'terminal-plan',
        createdAt: 100,
        updatedAt: 100
      },
      tasks: []
    });

    expect(database.recoverInterruptedOrchestrations()).toBe(1);
    expect(database.getOrchestration('run-planning')?.run).toMatchObject({
      status: 'blocked',
      planningError: 'Relay restarted before planning finished.'
    });
    database.close();
  });

  it('persists orchestrator runs and tasks', () => {
    const database = temporaryDatabase();
    database.open();
    database.createOrchestration({
      run: {
        id: 'run-1',
        objective: 'Build the feature',
        repoRoot: '/tmp/project',
        baseBranch: 'main',
        status: 'queued',
        strategy: 'parallel',
        concurrency: 2,
        planningProvider: 'claude',
        planningModel: 'claude-opus-4-1',
        planningProviders: ['claude', 'codex'],
        planningProfileIds: ['profile-frontend'],
        parentRunId: 'run-original',
        replanContext: 'The original worker was blocked.',
        synthesisStatus: 'completed',
        synthesisProvider: 'claude',
        synthesisModel: 'claude-opus-4-1',
        synthesisTerminalId: 'terminal-outcome',
        finalSummary: 'The replacement completed successfully.',
        createdAt: 100,
        updatedAt: 100
      },
      tasks: [{
        id: 'task-1',
        runId: 'run-1',
        ordinal: 0,
        title: 'Build',
        instructions: 'Build the feature',
        role: 'builder',
        deliverable: 'Working feature',
        provider: 'codex',
        status: 'queued',
        attempt: 0,
        blocker: 'Waiting for an SDK.',
        createdAt: 100,
        updatedAt: 100
      }]
    });

    const snapshot = database.getOrchestration('run-1');
    expect(snapshot?.run).toMatchObject({
      objective: 'Build the feature',
      status: 'queued',
      strategy: 'parallel',
      planningProvider: 'claude',
      planningProviders: ['claude', 'codex'],
      planningProfileIds: ['profile-frontend'],
      parentRunId: 'run-original',
      synthesisStatus: 'completed',
      finalSummary: 'The replacement completed successfully.'
    });
    expect(snapshot?.tasks[0]).toMatchObject({
      role: 'builder',
      deliverable: 'Working feature',
      blocker: 'Waiting for an SDK.'
    });
    expect(snapshot?.tasks).toHaveLength(1);
    expect(database.listOrchestrations('/tmp/project')).toHaveLength(1);
    expect(database.recoverInterruptedOrchestrations()).toBe(1);
    expect(database.getOrchestration('run-1')).toMatchObject({
      run: { status: 'blocked' },
      tasks: [{ status: 'blocked' }]
    });
    database.close();
  });
});
