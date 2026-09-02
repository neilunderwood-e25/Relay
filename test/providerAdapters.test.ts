import { describe, expect, it } from 'vitest';
import { providerAdapter, providerAdapters } from '../src/main/providerAdapters';

describe('provider adapters', () => {
  it('registers every supported CLI in one adapter plane', () => {
    expect(providerAdapters().map(({ id, command }) => ({ id, command }))).toEqual([
      { id: 'claude', command: 'claude' },
      { id: 'codex', command: 'codex' },
      { id: 'cursor', command: 'agent' }
    ]);
  });

  it('adds model choices as argv values and keeps verification read-only', () => {
    const claudeWorker = providerAdapter('claude').workerArgs('Ship it', 'claude-sonnet-4-5');
    expect(claudeWorker.slice(0, 4))
      .toEqual(['--model', 'claude-sonnet-4-5', '--print', '--permission-mode']);
    expect(claudeWorker).toContain('auto');
    expect(claudeWorker).not.toContain('--allowedTools');
    expect(providerAdapter('codex').workerArgs('Ship it', 'gpt-5.3-codex')).toContain('workspace-write');
    expect(providerAdapter('codex').verificationArgs('Check it', 'gpt-5.3-codex')).toContain('read-only');
    const claudeVerification = providerAdapter('claude').verificationArgs('Check it', 'claude-opus-4-1');
    expect(claudeVerification).toContain('dontAsk');
    expect(claudeVerification).not.toContain('--tools');
    expect(claudeVerification).not.toContain('--allowedTools');
    expect(providerAdapter('claude').planningArgs('Plan it', 'claude-opus-4-1')).toContain('plan');
    expect(providerAdapter('claude').planningArgs('Plan it', 'claude-opus-4-1')).toContain('stream-json');
    expect(providerAdapter('claude').planningArgs('Plan it', 'claude-opus-4-1')).toContain('--include-partial-messages');
    expect(claudeVerification).toContain('--include-partial-messages');
    expect(providerAdapter('codex').planningArgs('Plan it', 'gpt-5.3-codex')).toContain('read-only');
    expect(providerAdapter('codex').planningArgs('Plan it', 'gpt-5.3-codex')).toContain('--json');
    const cursorPlanning = providerAdapter('cursor').planningArgs('Plan it', 'auto');
    expect(cursorPlanning).toContain('stream-json');
    expect(cursorPlanning).toContain('plan');
    const cursorVerification = providerAdapter('cursor').verificationArgs('Check it', 'auto');
    expect(cursorVerification).toContain('ask');
    expect(cursorVerification).toContain('enabled');
  });

  it('launches workers as interactive provider sessions', () => {
    const claude = providerAdapter('claude').interactiveWorkerArgs('claude-sonnet-4-5');
    expect(claude).toContain('auto');
    expect(claude).not.toContain('acceptEdits');
    expect(claude).not.toContain('--allowedTools');
    expect(claude).not.toContain('--safe-mode');
    expect(claude).not.toContain('--print');
    expect(claude).not.toContain('--no-session-persistence');

    const codex = providerAdapter('codex').interactiveWorkerArgs('gpt-5.3-codex');
    expect(codex).toContain('workspace-write');
    expect(codex).toContain('--no-alt-screen');
    expect(codex).not.toContain('exec');
    expect(codex).not.toContain('--ephemeral');

    const cursor = providerAdapter('cursor').interactiveWorkerArgs('auto');
    expect(cursor).toContain('--force');
    expect(cursor).toContain('enabled');
    expect(cursor).not.toContain('--print');
    expect(providerAdapter('cursor').interactiveWorkerArgs('auto', 'cursor-chat'))
      .toEqual(expect.arrayContaining(['--resume', 'cursor-chat']));
  });

  it('resumes the last provider conversation inside its dedicated worktree', () => {
    const nativeId = '01a057e7-ce82-7031-9fc4-cf3ec5800002';
    const claude = providerAdapter('claude').resumeWorkerArgs('sonnet', nativeId);
    expect(claude).toContain('--resume');
    expect(claude).toContain(nativeId);
    expect(claude).toContain('auto');
    expect(claude).not.toContain('acceptEdits');
    expect(claude).not.toContain('--print');

    const codex = providerAdapter('codex').resumeWorkerArgs('gpt-5.3-codex', nativeId);
    expect(codex.slice(-2)).toEqual(['resume', nativeId]);
    expect(codex).toContain('workspace-write');
    expect(codex).not.toContain('exec');
    expect(providerAdapter('claude').resumeWorkerArgs()).toContain('--continue');
    expect(providerAdapter('codex').resumeWorkerArgs().slice(-2)).toEqual(['resume', '--last']);
    expect(providerAdapter('cursor').resumeWorkerArgs('auto', nativeId)).toContain(nativeId);
    expect(providerAdapter('cursor').resumeWorkerArgs()).toContain('--continue');
  });

  it('assigns a deterministic Claude conversation id at first launch', () => {
    const nativeId = '01a057e7-ce82-7031-9fc4-cf3ec5800003';
    const args = providerAdapter('claude').interactiveWorkerArgs('sonnet', nativeId);
    expect(args).toContain('--session-id');
    expect(args).toContain(nativeId);
  });

  it('seeds the persistent orchestrator with trusted hive access', () => {
    const claude = providerAdapter('claude').orchestratorArgs('Relay protocol', '/relay/hive', 'opus');
    expect(claude).toContain('--append-system-prompt');
    expect(claude).toContain('--add-dir');
    expect(claude).toContain('/relay/hive');
    expect(claude).toContain('auto');
    expect(claude).not.toContain('acceptEdits');
    expect(claude).not.toContain('--restricted');
    expect(claude).not.toContain('--safe-mode');
    expect(claude).not.toContain('--strict-mcp-config');
    expect(claude).not.toContain('--allowedTools');

    const codex = providerAdapter('codex').orchestratorArgs('Relay protocol', '/relay/hive', 'gpt-5.6-sol');
    expect(codex).toContain('--no-alt-screen');
    expect(codex).toContain('workspace-write');
    expect(codex.at(-1)).toBe('Relay protocol');
  });
});
