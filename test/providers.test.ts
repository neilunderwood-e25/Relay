import { delimiter, join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProviders, isSafeCommandName, resolveExecutable } from '../src/main/providers';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('provider command validation', () => {
  it('accepts plain executable names', () => {
    expect(isSafeCommandName('claude')).toBe(true);
    expect(isSafeCommandName('codex-cli')).toBe(true);
    expect(isSafeCommandName('agent_2.0')).toBe(true);
  });

  it('rejects shell syntax and path fragments', () => {
    expect(isSafeCommandName('claude --version')).toBe(false);
    expect(isSafeCommandName('claude; rm')).toBe(false);
    expect(isSafeCommandName('../claude')).toBe(false);
    expect(isSafeCommandName('$(claude)')).toBe(false);
  });
});

describe('resolveExecutable', () => {
  it.skipIf(process.platform === 'win32')('resolves an executable from PATH without invoking a shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'foundry-provider-test-'));
    temporaryDirectories.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const executable = join(bin, 'test-agent');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o755);

    const path = [bin, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
    await expect(resolveExecutable('test-agent', { ...process.env, PATH: path })).resolves.toBe(executable);
  });

  it('rejects an unsafe command before searching PATH', async () => {
    await expect(resolveExecutable('claude --version')).resolves.toBeNull();
  });
});

describe('detectProviders', () => {
  it('always returns the complete initial provider catalog', async () => {
    const providers = await detectProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['claude', 'codex']);
    for (const provider of providers) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(typeof provider.available).toBe('boolean');
      expect(provider.available ? provider.version : provider.error).toBeTruthy();
    }
  });
});
