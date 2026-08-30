import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { RelayControlProtocol, orchestratorSessionPrompt } from '../src/main/controlProtocol';
import type { RelayControlCommand, TerminalSnapshot } from '../src/shared/contracts';

describe('RelayControlProtocol', () => {
  it('persists and serially delivers Monitor commands to one Michael session', async () => {
    const queued: RelayControlCommand[] = [];
    const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const submissions: string[] = [];
    const terminal = readyTerminal();
    let sequence = 0;
    let now = 10_000;
    const protocol = new RelayControlProtocol({
      hive: {
        root: '/relay/hive',
        enqueueControl: (command) => {
          queued.push(command);
          return `/relay/hive/control/inbox/${command.id}.json`;
        },
        pendingControlCommands: () => [],
        appendEvent: (kind, payload) => events.push({ kind, payload })
      },
      terminals: {
        list: () => [terminal],
        submit: async (_id, text) => {
          submissions.push(text);
          terminal.lastSequence += 1;
          terminal.lastOutputAt = now;
          return { ok: true };
        }
      },
      ensureTerminal: async () => terminal,
      logger: loggerStub(),
      now: () => now += 2_000,
      createId: () => `control-test-${++sequence}`
    });

    protocol.dispatch(commandInput('run.started'));
    protocol.dispatch(commandInput('run.verification_requested'));
    const completed = protocol.syncSnapshot(completedSnapshot());
    const duplicate = protocol.syncSnapshot(completedSnapshot());
    const verified = protocol.syncSnapshot(completedSnapshot('passed'));
    await protocol.flush();

    expect(queued.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: 'control-test-1', kind: 'run.started' },
      { id: 'control-test-2', kind: 'run.verification_requested' },
      { id: 'control-test-3', kind: 'run.completed' },
      { id: 'control-test-4', kind: 'run.verified' }
    ]);
    expect(completed?.kind).toBe('run.completed');
    expect(completed?.actor).toBe('relay');
    expect(duplicate).toBeNull();
    expect(verified?.kind).toBe('run.verified');
    expect(submissions).toHaveLength(4);
    expect(submissions[0]).toContain('[RELAY CONTROL control-test-1]');
    expect(submissions[0]).toContain('Do not duplicate workers or edit the main checkout.');
    expect(submissions[1]).toContain('[RELAY CONTROL control-test-2]');
    expect(submissions[2]).toContain('run.completed');
    expect(events.filter(({ kind }) => kind === 'control.delivered')).toHaveLength(4);
  });

  it('keeps failed commands durable and continues draining the queue', async () => {
    const events: string[] = [];
    const terminal = readyTerminal();
    let attempts = 0;
    let sequence = 0;
    let now = 10_000;
    const protocol = new RelayControlProtocol({
      hive: {
        root: '/relay/hive',
        enqueueControl: (command) => `/relay/hive/control/inbox/${command.id}.json`,
        pendingControlCommands: () => [],
        appendEvent: (kind) => events.push(kind)
      },
      terminals: {
        list: () => [terminal],
        submit: async () => {
          attempts += 1;
          if (attempts === 1) return { ok: false, error: 'busy' };
          terminal.lastSequence += 1;
          terminal.lastOutputAt = now;
          return { ok: true };
        }
      },
      ensureTerminal: async () => terminal,
      logger: loggerStub(),
      now: () => now += 2_000,
      createId: () => `control-test-${++sequence}`
    });

    protocol.dispatch(commandInput('run.started'));
    protocol.dispatch(commandInput('run.stopped'));
    await protocol.flush();

    expect(events).toContain('control.delivery_failed');
    expect(events).toContain('control.delivered');
  });

  it('routes one human input to Michael with an exact Monitor action envelope', async () => {
    const queued: RelayControlCommand[] = [];
    const submissions: string[] = [];
    const terminal = readyTerminal();
    let now = 10_000;
    const protocol = new RelayControlProtocol({
      hive: {
        root: '/relay/hive',
        enqueueControl: (command) => {
          queued.push(command);
          return `/relay/hive/control/inbox/${command.id}.json`;
        },
        pendingControlCommands: () => [],
        appendEvent: vi.fn()
      },
      terminals: {
        list: () => [terminal],
        submit: async (_id, text) => {
          submissions.push(text);
          terminal.lastSequence += 1;
          terminal.lastOutputAt = now;
          return { ok: true };
        }
      },
      ensureTerminal: async () => terminal,
      projectPath: () => '/repo',
      logger: loggerStub(),
      now: () => now += 2_000,
      createId: () => 'control-input-1'
    });

    const receipt = protocol.submitInput({
      text: 'Build the feature',
      strategy: 'balanced',
      providers: ['claude', 'codex'],
      concurrency: 2
    });
    await protocol.flush();

    expect(receipt).toMatchObject({ id: 'control-input-1', status: 'queued' });
    expect(queued[0]).toMatchObject({ kind: 'input.submitted', projectPath: '/repo', runId: 'control-input-1' });
    expect(submissions[0]).toContain('[RELAY INPUT control-input-1]');
    expect(submissions[0]).toContain('/control/outbox/action-control-input-1.json');
    expect(submissions[0]).toContain('"kind":"run.create"');
  });

  it('seeds Michael with the durable control boundaries', () => {
    const prompt = orchestratorSessionPrompt('Michael', '/repo', '/relay/hive');
    expect(prompt).toContain("Michael, Relay's persistent orchestrator session");
    expect(prompt).toContain('/relay/hive/PROTOCOL.md');
    expect(prompt).toContain('/relay/hive/agents/orchestrator/context.md');
    expect(prompt).toContain('Never duplicate an active Monitor run');
  });

  it('replays durable commands that have no acknowledgment', async () => {
    const terminal = readyTerminal();
    const submissions: string[] = [];
    const command: RelayControlCommand = {
      version: 1,
      id: 'control-recovery-1',
      kind: 'run.started',
      actor: 'relay',
      createdAt: 100,
      projectPath: '/repo',
      runId: 'run-1',
      objective: 'Recover it',
      strategy: 'balanced',
      payload: {}
    };
    const protocol = new RelayControlProtocol({
      hive: {
        root: '/relay/hive',
        enqueueControl: vi.fn(() => '/unused'),
        pendingControlCommands: () => [{ command, path: '/relay/hive/control/inbox/recovery.json' }],
        appendEvent: vi.fn()
      },
      terminals: {
        list: () => [terminal],
        submit: async (_id, text) => {
          submissions.push(text);
          terminal.lastSequence += 1;
          terminal.lastOutputAt += 2_000;
          return { ok: true };
        }
      },
      ensureTerminal: async () => terminal,
      logger: loggerStub(),
      now: (() => { let now = 10_000; return () => now += 2_000; })()
    });

    expect(protocol.recover()).toBe(1);
    await protocol.flush();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain('[RELAY CONTROL control-recovery-1]');
  });
});

function commandInput(kind: 'run.started' | 'run.verification_requested' | 'run.stopped') {
  return {
    kind,
    projectPath: '/repo',
    runId: 'run-1',
    objective: 'Build the feature',
    strategy: 'balanced' as const,
    payload: {}
  };
}

function readyTerminal(): TerminalSnapshot {
  return {
    id: 'claude-michael',
    role: 'orchestrator',
    name: 'Michael',
    provider: 'claude',
    command: '/usr/bin/claude',
    cwd: '/repo',
    pid: 42,
    cols: 120,
    rows: 32,
    status: 'running',
    createdAt: 1,
    lastOutputAt: 1,
    hasOutput: true,
    lastSequence: 1
  };
}

function completedSnapshot(verificationStatus?: 'passed' | 'failed') {
  return {
    run: {
      id: 'run-1',
      objective: 'Build the feature',
      repoRoot: '/repo',
      baseBranch: 'main',
      status: 'completed' as const,
      strategy: 'balanced' as const,
      concurrency: 1,
      createdAt: 1,
      updatedAt: 2,
      finalSummary: 'Feature delivered.',
      verificationStatus
    },
    tasks: []
  };
}

function loggerStub(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}
