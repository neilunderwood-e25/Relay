import { describe, expect, it, vi } from 'vitest';
import { isClaudeWorkspaceTrustPrompt, prepareOrchestratorTerminal } from '../src/main/orchestratorBootstrap';
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
  });
});

function snapshot(cwd = '/relay/hive/agents/orchestrator'): TerminalSnapshot {
  return {
    id: 'claude-michael',
    role: 'orchestrator',
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
