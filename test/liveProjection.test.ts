import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveMonitorProjection, projectTerminalLines } from '../src/main/liveProjection';
import type { OrchestrationSnapshot, TerminalSnapshot } from '../src/shared/contracts';

afterEach(() => {
  vi.useRealTimers();
});

describe('projectTerminalLines', () => {
  it('removes terminal control sequences and applies carriage-return replacement', () => {
    expect(projectTerminalLines('booting\rready\n\x1b[31mDone\x1b[0m\n')).toEqual(['ready', 'Done']);
  });

  it('bounds projected lines and each visible line', () => {
    const lines = projectTerminalLines([
      'x'.repeat(500),
      ...Array.from({ length: 10 }, (_, index) => `line ${index}`)
    ].join('\n'));
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('line 2');
    expect(lines.every((line) => line.length <= 240)).toBe(true);
  });
});

describe('LiveMonitorProjection', () => {
  it('projects only the attached Michael terminal and tracks delivery state', () => {
    vi.useFakeTimers();
    const updates: ReturnType<LiveMonitorProjection['snapshot']>[] = [];
    let now = 1_000;
    const projection = new LiveMonitorProjection({
      onUpdate: (snapshot) => updates.push(snapshot),
      now: () => ++now
    });
    projection.attach(terminal(), 'Welcome\n');
    projection.begin('control-1', 'Reading input');
    projection.handleData({ id: 'worker-1', data: 'ignore me', sequence: 2 });
    projection.handleData({ id: 'michael-1', data: '\x1b[32mPlanning\x1b[0m\n', sequence: 3 });
    vi.advanceTimersByTime(80);

    expect(updates.at(-1)).toMatchObject({
      terminalId: 'michael-1',
      status: 'working',
      lastSequence: 3,
      lines: ['Welcome', 'Planning']
    });
    expect(updates.at(-1)?.events.map(({ label }) => label)).toEqual(['Session started', 'Reading input']);

    projection.end('control-1');
    vi.advanceTimersByTime(80);
    expect(updates.at(-1)?.status).toBe('ready');
    projection.dispose();
  });

  it('deduplicates run projections and marks terminal failures', () => {
    vi.useFakeTimers();
    const projection = new LiveMonitorProjection({ onUpdate: vi.fn(), now: () => 2_000 });
    projection.attach(terminal());
    projection.recordRun(runSnapshot('planning'));
    projection.recordRun(runSnapshot('planning'));
    projection.recordRun(runSnapshot('running'));
    projection.handleExit({ id: 'michael-1', exitCode: 1, exitedAt: 3_000 });

    expect(projection.snapshot().events.map(({ label }) => label)).toEqual([
      'Session started',
      'Planning run',
      'Team working',
      'Session failed'
    ]);
    expect(projection.snapshot().status).toBe('error');
    projection.dispose();
  });
});

function terminal(): TerminalSnapshot {
  return {
    id: 'michael-1',
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

function runSnapshot(status: 'planning' | 'running'): OrchestrationSnapshot {
  return {
    run: {
      id: 'run-1',
      objective: 'Build it',
      repoRoot: '/repo',
      baseBranch: 'main',
      status,
      strategy: 'balanced',
      concurrency: 1,
      createdAt: 1,
      updatedAt: 2
    },
    tasks: []
  };
}
