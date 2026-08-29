import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestrationSnapshot } from '../src/shared/contracts';
import { personNameForSeed } from '../src/shared/agentIdentity';
import { HiveManager } from '../src/main/hive';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { root: string; hive: HiveManager } {
  const root = mkdtempSync(join(tmpdir(), 'relay-hive-test-'));
  temporaryDirectories.push(root);
  return { root, hive: new HiveManager(join(root, 'hive'), 'Michael') };
}

describe('HiveManager', () => {
  it('creates Michael and the shared hive idempotently', () => {
    const { hive } = fixture();
    expect(hive.ensure()).toMatchObject({ ready: true, path: hive.root, agentPath: hive.agentRoot });

    for (const path of [
      'PROTOCOL.md',
      'board.md',
      'tasks.json',
      'registry.json',
      'log.jsonl',
      'messages.jsonl',
      'agents/orchestrator/identity.md',
      'agents/orchestrator/memory.md',
      'agents/orchestrator/cursor.json',
      'agents/orchestrator/inbox/.done',
      'agents/orchestrator/outbox/.sent'
    ]) expect(existsSync(join(hive.root, path))).toBe(true);

    const memoryPath = join(hive.agentRoot, 'memory.md');
    writeFileSync(memoryPath, '# durable memory\n', 'utf8');
    const boardPath = join(hive.root, 'board.md');
    writeFileSync(boardPath, '# Foundry board\n\n_Rehan owns this shared plan._\n', 'utf8');
    expect(hive.ensure().ready).toBe(true);
    expect(readFileSync(memoryPath, 'utf8')).toBe('# durable memory\n');
    expect(readFileSync(boardPath, 'utf8')).toBe('# Relay board\n\n_Michael owns this shared plan._\n');
  });

  it('records the selected orchestrator engine', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-hive-engine-test-'));
    temporaryDirectories.push(root);
    const hive = new HiveManager(join(root, 'hive'), 'Michael', 'codex', 'gpt-5.6-sol');
    hive.ensure();

    const identity = readFileSync(join(hive.agentRoot, 'identity.md'), 'utf8');
    expect(identity).toContain('- Engine: Codex CLI');
    expect(identity).toContain('- Model: GPT-5.6 Sol');
  });

  it('mirrors orchestration tasks and orchestrator status into the hive', () => {
    const { hive } = fixture();
    hive.ensure();
    hive.syncOrchestrations([snapshot('running')]);

    const ledger = JSON.parse(readFileSync(join(hive.root, 'tasks.json'), 'utf8')) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(ledger.tasks).toMatchObject([{
      id: 'task-1',
      runId: 'run-1',
      title: 'Build API',
      assignee: personNameForSeed('task-1'),
      role: 'builder',
      status: 'doing'
    }]);
    const registry = JSON.parse(readFileSync(join(hive.root, 'registry.json'), 'utf8')) as {
      agents: { orchestrator: { status: string; name: string } };
    };
    expect(registry.agents.orchestrator).toMatchObject({ status: 'working', name: 'Michael' });

    hive.syncOrchestrations([snapshot('completed')]);
    const completed = JSON.parse(readFileSync(join(hive.root, 'tasks.json'), 'utf8')) as {
      tasks: Array<{ status: string }>;
    };
    expect(completed.tasks[0].status).toBe('done');
  });

  it('renames the orchestrator without replacing durable memory', () => {
    const { hive } = fixture();
    hive.ensure();
    const memoryPath = join(hive.agentRoot, 'memory.md');
    writeFileSync(memoryPath, '# Keep this\n', 'utf8');

    hive.renameOrchestrator('Avery');

    expect(readFileSync(join(hive.agentRoot, 'identity.md'), 'utf8')).toContain('# Avery');
    expect(readFileSync(memoryPath, 'utf8')).toBe('# Keep this\n');
    const registry = JSON.parse(readFileSync(join(hive.root, 'registry.json'), 'utf8')) as {
      orchestratorId: string;
      agents: Record<string, { name: string }>;
    };
    expect(registry.orchestratorId).toBe('orchestrator');
    expect(registry.agents.orchestrator.name).toBe('Avery');
    expect(registry.agents.claude.name).toBe('Claude');
    expect(registry.agents.codex.name).toBe('Codex');
  });

  it('delivers durable worker messages to the orchestrator inbox', () => {
    const { hive } = fixture();
    hive.ensure();
    hive.appendMessage({
      id: 'message-1',
      runId: 'run-1',
      taskId: 'task-1',
      from: 'Avery',
      to: 'orchestrator',
      kind: 'blocker',
      body: 'Generated SDK is missing.\nPlease regenerate it.',
      createdAt: 200
    });

    expect(readFileSync(join(hive.root, 'messages.jsonl'), 'utf8')).toContain('Generated SDK is missing. Please regenerate it.');
    expect(readFileSync(join(hive.agentRoot, 'inbox', '200-message-1.json'), 'utf8')).toContain('"kind": "blocker"');
  });
});

function snapshot(status: 'running' | 'completed'): OrchestrationSnapshot {
  return {
    run: {
      id: 'run-1',
      objective: 'Build an API',
      repoRoot: '/repo',
      baseBranch: 'main',
      strategy: 'balanced',
      status,
      concurrency: 1,
      createdAt: 100,
      updatedAt: 200
    },
    tasks: [{
      id: 'task-1',
      runId: 'run-1',
      ordinal: 0,
      title: 'Build API',
      instructions: 'Implement the API',
      role: 'builder',
      deliverable: 'Working API',
      provider: 'codex',
      status,
      attempt: 1,
      createdAt: 100,
      updatedAt: 200
    }]
  };
}
