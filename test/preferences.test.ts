import { describe, expect, it } from 'vitest';
import { normalizePreferences } from '../src/main/preferences';

describe('Relay preferences', () => {
  it('uses safe defaults for missing or invalid values', () => {
    expect(normalizePreferences()).toEqual({
      defaultStrategy: 'balanced',
      maxConcurrentAgents: 2,
      verificationProvider: null
    });
    expect(normalizePreferences({
      defaultStrategy: 'unknown' as never,
      maxConcurrentAgents: 99,
      verificationProvider: 'unknown' as never
    })).toEqual({
      defaultStrategy: 'balanced',
      maxConcurrentAgents: 4,
      verificationProvider: null
    });
  });

  it('keeps supported run defaults', () => {
    expect(normalizePreferences({
      defaultStrategy: 'parallel',
      maxConcurrentAgents: 3,
      verificationProvider: 'codex'
    })).toEqual({
      defaultStrategy: 'parallel',
      maxConcurrentAgents: 3,
      verificationProvider: 'codex'
    });
  });
});
