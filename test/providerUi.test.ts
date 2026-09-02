import { describe, expect, it } from 'vitest';
import type { ProviderCapability } from '../src/shared/contracts';
import {
  providerModelOptions,
  providerReady,
  providerState,
  providerStatusDetail,
  providerStatusLabel
} from '../src/renderer/src/providerUi';

describe('unified provider presentation', () => {
  it('distinguishes ready, signed-out, missing, and broken CLIs', () => {
    const ready = capability({ authenticated: true, version: '1.2.3', models: ['auto', 'fast'] });
    const signedOut = capability({ authenticated: false, authenticationError: 'Not logged in' });
    const missing = capability({ available: false, executablePath: null, error: 'Not installed' });
    const broken = capability({ available: false, executablePath: '/bin/agent', error: 'Version failed' });

    expect(providerState(ready)).toBe('ready');
    expect(providerStatusLabel(signedOut)).toBe('Sign in');
    expect(providerState(missing)).toBe('missing');
    expect(providerState(broken)).toBe('error');
    expect(providerReady(signedOut)).toBe(false);
    expect(providerStatusDetail(ready)).toBe('1.2.3 · 2 models');
    expect(providerStatusDetail(signedOut)).toBe('Not logged in');
  });

  it('merges discovered models with provider defaults without duplicates', () => {
    const options = providerModelOptions('cursor', capability({ models: ['auto', 'composer-2', 'auto'] }));

    expect(options.map(({ id }) => id)).toEqual([null, 'auto', 'composer-2']);
  });
});

function capability(overrides: Partial<ProviderCapability> = {}): ProviderCapability {
  return {
    id: 'cursor',
    label: 'Cursor Agent',
    command: 'agent',
    available: true,
    executablePath: '/bin/agent',
    version: '1.0.0',
    error: null,
    authenticated: null,
    authenticationError: null,
    models: [],
    supportsAcp: false,
    ...overrides
  };
}
