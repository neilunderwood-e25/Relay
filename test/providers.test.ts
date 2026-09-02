import { delimiter, join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { detectProvider, detectProviders, isSafeCommandName, resolveExecutable, resolveProviderExecutable } from '../src/main/providers';

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
    const root = mkdtempSync(join(tmpdir(), 'relay-provider-test-'));
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

  it.skipIf(process.platform === 'win32')('falls back to the cursor-agent executable alias', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cursor-alias-'));
    temporaryDirectories.push(root);
    const executable = join(root, 'cursor-agent');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(executable, 0o755);
    await expect(resolveProviderExecutable('cursor', { PATH: root })).resolves.toBe(executable);
  });
});

describe('detectProviders', () => {
  it.skipIf(process.platform === 'win32')('reports authentication for Claude and Codex without running a prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-provider-auth-'));
    temporaryDirectories.push(root);
    const executable = join(root, 'provider-runtime');
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "provider 1.2.3"; exit 0; fi
if [ "$1" = "auth" ] || [ "$1" = "login" ]; then echo "Logged in"; exit 0; fi
exit 2
`, 'utf8');
    chmodSync(executable, 0o755);

    for (const id of ['claude', 'codex'] as const) {
      await expect(detectProvider({
        id,
        label: id,
        command: executable,
        versionArgs: ['--version']
      })).resolves.toMatchObject({ available: true, authenticated: true });
    }
  });

  it.skipIf(process.platform === 'win32')('distinguishes an installed CLI that needs sign in', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-provider-signed-out-'));
    temporaryDirectories.push(root);
    const executable = join(root, 'provider-runtime');
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "provider 1.2.3"; exit 0; fi
echo "Not logged in" >&2
exit 1
`, 'utf8');
    chmodSync(executable, 0o755);

    await expect(detectProvider({
      id: 'codex',
      label: 'Codex',
      command: executable,
      versionArgs: ['--version']
    })).resolves.toMatchObject({
      available: true,
      authenticated: false,
      authenticationError: 'Not logged in'
    });
  });

  it.skipIf(process.platform === 'win32')('validates Cursor authentication, models, and ACP support', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cursor-capability-'));
    temporaryDirectories.push(root);
    const executable = join(root, 'cursor-runtime');
    writeFileSync(executable, `#!/bin/sh
case "$1" in
  --version) echo "cursor 1.2.3" ;;
  status) echo "Logged in" ;;
  --list-models) printf "Available models\\nauto - Auto (default)\\ncomposer-2 - Composer 2\\n" ;;
  --help) echo "Commands: acp status models" ;;
esac
`, 'utf8');
    chmodSync(executable, 0o755);

    await expect(detectProvider({
      id: 'cursor', label: 'Cursor Agent', command: executable, versionArgs: ['--version']
    })).resolves.toMatchObject({
      id: 'cursor',
      available: true,
      authenticated: true,
      models: ['auto', 'composer-2'],
      supportsAcp: true
    });
  });

  it('always returns the complete initial provider catalog', async () => {
    const providers = await detectProviders();

    expect(providers.map((provider) => provider.id)).toEqual(['claude', 'codex', 'cursor']);
    for (const provider of providers) {
      expect(provider.label.length).toBeGreaterThan(0);
      expect(typeof provider.available).toBe('boolean');
      expect(provider.available ? provider.version : provider.error).toBeTruthy();
    }
    const cursor = providers.find(({ id }) => id === 'cursor');
    for (const provider of providers) {
      expect(provider.authenticated === null || typeof provider.authenticated === 'boolean').toBe(true);
      expect(Array.isArray(provider.models)).toBe(true);
    }
  }, 10_000);
});
