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
    expect(providerAdapter('claude').workerArgs('Ship it', 'claude-sonnet-4-5').slice(0, 4))
      .toEqual(['--model', 'claude-sonnet-4-5', '--print', '--permission-mode']);
    expect(providerAdapter('codex').workerArgs('Ship it', 'gpt-5.3-codex')).toContain('workspace-write');
    expect(providerAdapter('codex').verificationArgs('Check it', 'gpt-5.3-codex')).toContain('read-only');
  });
});
