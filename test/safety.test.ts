import { describe, expect, it, vi } from 'vitest';
import type { AgentSession, OrchestrationSnapshot, OrchestrationTask, WorktreeRecord } from '../src/shared/contracts';
import { SafetyBoundary, SafetyBoundaryError } from '../src/main/safety';

function fixture() {
  const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  const run = {
    run: {
      id: 'run-current', objective: 'Build', repoRoot: '/projects/current', baseBranch: 'main',
      status: 'running', strategy: 'balanced', concurrency: 1, createdAt: 1, updatedAt: 1
    },
    tasks: []
  } as OrchestrationSnapshot;
  const foreignRun = {
    ...run,
    run: { ...run.run, id: 'run-foreign', repoRoot: '/projects/foreign' }
  } as OrchestrationSnapshot;
  const task = {
    id: 'task-current', runId: run.run.id, ordinal: 0, title: 'Task', instructions: 'Build',
    role: 'builder', deliverable: 'Code', provider: 'codex', status: 'running', attempt: 1,
    createdAt: 1, updatedAt: 1
  } as OrchestrationTask;
  const agentSession = {
    id: 'session-current', runId: run.run.id, initialTaskId: task.id, provider: 'codex', status: 'idle',
    agentName: 'Sam', avatarSeed: 'sam', createdAt: 1, updatedAt: 1
  } as AgentSession;
  const database = {
    getAgentSession: vi.fn((id: string) => id === agentSession.id ? agentSession : undefined),
    getOrchestration: vi.fn((id: string) => id === run.run.id ? run : id === foreignRun.run.id ? foreignRun : undefined),
    getOrchestrationTask: vi.fn((id: string) => id === task.id ? task : undefined),
    getWorktree: vi.fn((_id: string): WorktreeRecord | undefined => undefined),
    appendEvent: vi.fn((type: string, payload?: Record<string, unknown>) => events.push({ type, payload }))
  };
  return { boundary: new SafetyBoundary(database, () => '/projects/current'), events };
}

describe('SafetyBoundary', () => {
  it('allows only the selected project and records denied path requests', () => {
    const { boundary, events } = fixture();
    expect(boundary.assertProjectPath('/projects/current', 'repository.inspect')).toBe('/projects/current');
    expect(() => boundary.assertProjectPath('/projects/foreign', 'repository.inspect'))
      .toThrow(SafetyBoundaryError);
    expect(events).toEqual([expect.objectContaining({
      type: 'app.safety.denied',
      payload: expect.objectContaining({ operation: 'repository.inspect' })
    })]);
  });

  it('scopes run and task ids to the selected project', () => {
    const { boundary } = fixture();
    expect(boundary.assertRun('run-current', 'run.stop').run.id).toBe('run-current');
    expect(boundary.assertTask('task-current', 'task.retry').id).toBe('task-current');
    expect(boundary.assertAgentSession('session-current', 'agent-session.stop').id).toBe('session-current');
    expect(() => boundary.assertRun('run-foreign', 'run.stop')).toThrow('outside the selected project');
    expect(() => boundary.assertTask('missing', 'task.retry')).toThrow('task was not found');
  });

  it('rejects privileged renderer terminals, custom argv, and foreign directories', () => {
    const { boundary } = fixture();
    const allowed = ['/projects/current', '/projects/current/.relay/worktrees/agent'];
    expect(boundary.assertRendererTerminal({ provider: 'claude', cwd: allowed[1] }, allowed))
      .toMatchObject({ role: 'worker', cwd: allowed[1], outputMode: 'terminal' });
    expect(() => boundary.assertRendererTerminal({
      provider: 'claude', role: 'orchestrator', cwd: allowed[0]
    }, allowed)).toThrow('privileged role');
    expect(() => boundary.assertRendererTerminal({
      provider: 'codex', cwd: allowed[0], args: ['--dangerously-bypass-approvals-and-sandbox']
    }, allowed)).toThrow('cannot supply CLI arguments');
    expect(() => boundary.assertRendererTerminal({ provider: 'codex', cwd: '/tmp' }, allowed))
      .toThrow('outside the selected project worktrees');
  });

  it('allows interactive terminals but protects internal event-stream terminals', () => {
    const { boundary, events } = fixture();
    const worker = {
      id: 'worker-1', role: 'worker', name: 'Sam', provider: 'codex', command: 'codex',
      cwd: '/projects/current', pid: 10, cols: 120, rows: 32, status: 'running',
      createdAt: 1, lastOutputAt: 1, hasOutput: true, lastSequence: 1, outputMode: 'terminal'
    } as const;
    const planner = { ...worker, id: 'planner-1', role: 'planner', outputMode: 'event-stream' } as const;
    expect(boundary.assertRendererTerminalControl(worker, 'terminal.write').id).toBe('worker-1');
    expect(boundary.assertRendererTerminalView(planner, 'terminal.replay').id).toBe('planner-1');
    expect(() => boundary.assertRendererTerminalControl(planner, 'terminal.write'))
      .toThrow('Internal Relay terminals');
    expect(() => boundary.assertRendererTerminalControl(undefined, 'terminal.stop'))
      .toThrow('terminal was not found');
    expect(events.filter(({ type }) => type === 'app.safety.denied')).toHaveLength(2);
  });
});
