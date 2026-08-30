import { describe, expect, it } from 'vitest';
import { providerAdapter, providerAdapters } from '../src/main/providerAdapters';

describe('provider adapters', () => {
  it('registers every supported CLI in one adapter plane', () => {
    expect(providerAdapters().map(({ id, command }) => ({ id, command }))).toEqual([
      { id: 'claude', command: 'claude' },
      { id: 'codex', command: 'codex' }
    ]);
  });

  it('adds model choices as argv values and keeps verification read-only', () => {
    const claudeWorker = providerAdapter('claude').workerArgs('Ship it', 'claude-sonnet-4-5');
    expect(claudeWorker.slice(0, 4))
      .toEqual(['--model', 'claude-sonnet-4-5', '--print', '--permission-mode']);
    expect(claudeWorker).toContain('Bash,Read,Glob,Grep,Edit,Write');
    expect(providerAdapter('codex').workerArgs('Ship it', 'gpt-5.3-codex')).toContain('workspace-write');
    expect(providerAdapter('codex').verificationArgs('Check it', 'gpt-5.3-codex')).toContain('read-only');
    const claudeVerification = providerAdapter('claude').verificationArgs('Check it', 'claude-opus-4-1');
    expect(claudeVerification).toContain('dontAsk');
    expect(claudeVerification).toContain('Bash,Read,Glob,Grep');
    expect(claudeVerification).not.toContain('Edit');
    expect(claudeVerification).not.toContain('Write');
    expect(providerAdapter('claude').planningArgs('Plan it', 'claude-opus-4-1')).toContain('plan');
    expect(providerAdapter('claude').planningArgs('Plan it', 'claude-opus-4-1')).toContain('stream-json');
    expect(providerAdapter('codex').planningArgs('Plan it', 'gpt-5.3-codex')).toContain('read-only');
    expect(providerAdapter('codex').planningArgs('Plan it', 'gpt-5.3-codex')).toContain('--json');
  });

  it('seeds the persistent orchestrator with trusted hive access', () => {
    const claude = providerAdapter('claude').orchestratorArgs('Relay protocol', '/relay/hive', 'opus');
    expect(claude).toContain('--append-system-prompt');
    expect(claude).toContain('--add-dir');
    expect(claude).toContain('/relay/hive');
    expect(claude).toContain('acceptEdits');
    expect(claude).toContain('--restricted');
    expect(claude).toContain('--safe-mode');
    expect(claude).toContain('--strict-mcp-config');

    const codex = providerAdapter('codex').orchestratorArgs('Relay protocol', '/relay/hive', 'gpt-5.6-sol');
    expect(codex).toContain('--no-alt-screen');
    expect(codex).toContain('workspace-write');
    expect(codex.at(-1)).toBe('Relay protocol');
  });
});
