import { describe, expect, it, vi } from 'vitest';
import {
  isClaudeWorkspaceTrustPrompt,
  isCodexWorkspaceTrustPrompt,
  isCodexUpdatePrompt,
  prepareOrchestratorTerminal,
  prepareWorkerTerminal
} from '../src/main/orchestratorBootstrap';
import type { TerminalSnapshot } from '../src/shared/contracts';

describe('orchestrator bootstrap', () => {
  it('accepts only Claude workspace trust for Relay own Hive and waits for the real prompt', async () => {
    let now = 1_000;
    const writes: string[] = [];
    const terminal = snapshot();
    let output = 'Quick safety check: Is this a project you created?\n> No, exit\n  Yes, I trust this folder';

    const result = await prepareOrchestratorTerminal(terminal, '/relay/hive/agents/orchestrator', {
      list: () => [{ ...terminal }],
      replay: () => ({ data: output, lastSequence: terminal.lastSequence }),
      write: async (_id, data) => {
        writes.push(data);
        output = 'Claude Code ready';
        terminal.lastSequence += 1;
        terminal.lastOutputAt = now;
        return { ok: true };
      }
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });

    expect(writes).toEqual(['\x1b[B', '\r']);
    expect(result.acceptedWorkspaceTrust).toBe(true);
    expect(result.terminal.lastSequence).toBeGreaterThan(1);
  });

  it('never confirms a trust prompt outside the Relay Hive agent root', async () => {
    const terminal = snapshot('/other/project');
    await expect(prepareOrchestratorTerminal(terminal, '/relay/hive/agents/orchestrator', {
      list: () => [terminal],
      replay: () => ({ data: '', lastSequence: 0 }),
      write: vi.fn()
    })).rejects.toThrow('Hive agent directory');
  });

  it('does not mistake unrelated terminal text for the workspace trust prompt', () => {
    expect(isClaudeWorkspaceTrustPrompt('Authenticate to continue')).toBe(false);
    expect(isClaudeWorkspaceTrustPrompt('Yes, I trust this folder')).toBe(false);
    expect(isCodexWorkspaceTrustPrompt('Yes, continue')).toBe(false);
    expect(isCodexUpdatePrompt('A new version is available')).toBe(false);
  });

  it('accepts Claude workspace trust for the exact managed worker worktree', async () => {
    let now = 1_000;
    const writes: string[] = [];
    const terminal = snapshot('/repo/.relay/worktrees/task-1', 'worker');
    let output = 'Quick safety check:\n> No, exit\n  Yes, I trust this folder';

    const result = await prepareWorkerTerminal(terminal, '/repo/.relay/worktrees/task-1', {
      list: () => [{ ...terminal }],
      replay: () => ({ data: output, lastSequence: terminal.lastSequence }),
      write: async (_id, data) => {
        writes.push(data);
        output = 'Claude Code ready';
        terminal.lastSequence += 1;
        terminal.lastOutputAt = now;
        return { ok: true };
      }
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });

    expect(writes).toEqual(['\x1b[B', '\r']);
    expect(result.acceptedWorkspaceTrust).toBe(true);
  });

  it('never confirms worker trust outside its assigned worktree', async () => {
    const terminal = snapshot('/other/worktree', 'worker');
    await expect(prepareWorkerTerminal(terminal, '/repo/.relay/worktrees/task-1', {
      list: () => [terminal],
      replay: () => ({ data: '', lastSequence: 0 }),
      write: vi.fn()
    })).rejects.toThrow('managed Relay worktree');
  });

  it('confirms the default Codex trust choice in a managed worker worktree', async () => {
    let now = 1_000;
    const writes: string[] = [];
    const terminal = { ...snapshot('/repo/.relay/worktrees/task-2', 'worker'), provider: 'codex' as const };
    let output = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n2. No, quit';

    const result = await prepareWorkerTerminal(terminal, terminal.cwd, {
      list: () => [{ ...terminal }],
      replay: () => ({ data: output, lastSequence: terminal.lastSequence }),
      write: async (_id, data) => {
        writes.push(data);
        output = 'Codex ready';
        terminal.lastSequence += 1;
        terminal.lastOutputAt = now;
        return { ok: true };
      }
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });

    expect(writes).toEqual(['\r']);
    expect(result.acceptedWorkspaceTrust).toBe(true);
  });

  it('skips a Codex update before confirming managed-worktree trust', async () => {
    let now = 1_000;
    const writes: string[] = [];
    const terminal = { ...snapshot('/repo/.relay/worktrees/task-3', 'worker'), provider: 'codex' as const };
    let output = 'https://github.com/openai/codex/releases/latest\n› 1. Update now\n2. Skip';

    const result = await prepareWorkerTerminal(terminal, terminal.cwd, {
      list: () => [{ ...terminal }],
      replay: () => ({ data: output, lastSequence: terminal.lastSequence }),
      write: async (_id, data) => {
        writes.push(data);
        if (writes.length === 2) output = 'Do you trust the contents of this directory?\n› 1. Yes, continue\n2. No, quit';
        else if (writes.length === 3) output = 'Codex ready';
        terminal.lastSequence += 1;
        terminal.lastOutputAt = now;
        return { ok: true };
      }
    }, {
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; }
    });

    expect(writes).toEqual(['\x1b[B', '\r', '\r']);
    expect(result.acceptedWorkspaceTrust).toBe(true);
  });
});

function snapshot(cwd = '/relay/hive/agents/orchestrator', role: 'orchestrator' | 'worker' = 'orchestrator'): TerminalSnapshot {
  return {
    id: 'claude-michael',
    role,
    name: 'Michael',
    provider: 'claude',
    command: '/usr/bin/claude',
    cwd,
    pid: 42,
    cols: 120,
    rows: 32,
    status: 'running',
    createdAt: 1,
    lastOutputAt: 1_000,
    hasOutput: true,
    lastSequence: 1
  };
}
