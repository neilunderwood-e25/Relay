import { describe, expect, it } from 'vitest';
import { PERSON_NAMES, personNameForSeed } from '../src/shared/agentIdentity';

describe('agent identities', () => {
  it('keeps a 50-name person pool', () => {
    expect(PERSON_NAMES).toHaveLength(50);
    expect(new Set(PERSON_NAMES).size).toBe(50);
  });

  it('assigns a stable person name from an opaque agent seed', () => {
    expect(personNameForSeed('task-123')).toBe(personNameForSeed('task-123'));
    expect(PERSON_NAMES).toContain(personNameForSeed('terminal-987'));
  });
});
