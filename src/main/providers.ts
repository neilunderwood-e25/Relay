import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ProviderCapability, ProviderId } from '../shared/contracts';
import { providerAdapters } from './providerAdapters';

interface ProviderDefinition {
  id: ProviderId;
  label: string;
  command: string;
  commandAliases?: string[];
  versionArgs: string[];
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_VERSION_OUTPUT = 64 * 1024;
const PROVIDER_CACHE_MS = 10_000;
let cachedProviders: { expiresAt: number; value: ProviderCapability[] } | null = null;
let providerDiscovery: Promise<ProviderCapability[]> | null = null;

export function isSafeCommandName(command: string): boolean {
  return COMMAND_NAME.test(command);
}

export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string | null> {
  if (!isAbsolute(command) && !isSafeCommandName(command)) return null;

  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => extensions.map((extension) => join(directory, `${command}${extension}`)));

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      if (platform !== 'win32') await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }

  return null;
}

export async function detectProvider(
  definition: ProviderDefinition,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<ProviderCapability> {
  const executable = await resolveProviderDefinitionExecutable(definition, options.env);
  const executablePath = executable?.path ?? null;
  if (!executablePath) {
    return {
      id: definition.id,
      label: definition.label,
      command: definition.command,
      available: false,
      executablePath: null,
      version: null,
      error: `${definition.label} is not installed or is not available on PATH.`,
      authenticated: definition.id === 'cursor' ? false : null,
      authenticationError: null,
      models: [],
      supportsAcp: false
    };
  }

  try {
    const [version, inspection] = await Promise.all([
      readVersion(executablePath, definition.versionArgs, options.env, options.timeoutMs),
      inspectProvider(definition.id, executablePath, options.env, options.timeoutMs)
    ]);
    return {
      id: definition.id,
      label: definition.label,
      command: executable?.command ?? definition.command,
      available: true,
      executablePath,
      version,
      error: null,
      authenticated: inspection.authenticated,
      authenticationError: inspection.authenticationError,
      models: inspection.models,
      supportsAcp: inspection.supportsAcp
    };
  } catch (error) {
    return {
      id: definition.id,
      label: definition.label,
      command: executable?.command ?? definition.command,
      available: false,
      executablePath,
      version: null,
      error: error instanceof Error ? error.message : String(error),
      authenticated: definition.id === 'cursor' ? false : null,
      authenticationError: null,
      models: [],
      supportsAcp: false
    };
  }
}

export async function resolveProviderExecutable(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const definition = providerAdapters().find(({ id }) => id === provider);
  return definition ? (await resolveProviderDefinitionExecutable(definition, env))?.path ?? null : null;
}

export async function detectProviders(options: { force?: boolean } = {}): Promise<ProviderCapability[]> {
  const now = Date.now();
  if (!options.force && cachedProviders && cachedProviders.expiresAt > now) {
    return cachedProviders.value.map((provider) => ({ ...provider }));
  }
  if (!options.force && providerDiscovery) {
    return (await providerDiscovery).map((provider) => ({ ...provider }));
  }
  const discovery = Promise.all(providerAdapters().map((provider) => detectProvider(provider)));
  providerDiscovery = discovery;
  try {
    const value = await discovery;
    cachedProviders = { expiresAt: Date.now() + PROVIDER_CACHE_MS, value };
    return value.map((provider) => ({ ...provider }));
  } finally {
    if (providerDiscovery === discovery) providerDiscovery = null;
  }
}

export function clearProviderCache(): void {
  cachedProviders = null;
  providerDiscovery = null;
}

export function isProviderReady(provider: ProviderCapability): boolean {
  return provider.available && provider.authenticated !== false;
}

function readVersion(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath, args, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      finish(() => reject(new Error(`Version check timed out after ${timeoutMs}ms.`)));
    }, timeoutMs);

    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_VERSION_OUTPUT
        ? current
        : (current + chunk.toString()).slice(0, MAX_VERSION_OUTPUT);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      const output = `${stdout}\n${stderr}`.trim();
      if (code !== 0) {
        reject(new Error(output || `Version check exited with code ${code ?? 'unknown'}.`));
        return;
      }
      resolve(output.split(/\r?\n/, 1)[0]?.trim() || 'unknown');
    }));
  });
}

async function resolveProviderDefinitionExecutable(
  definition: ProviderDefinition,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ command: string; path: string } | null> {
  for (const command of [definition.command, ...(definition.commandAliases ?? [])]) {
    const path = await resolveExecutable(command, env);
    if (path) return { command, path };
  }
  return null;
}

async function inspectProvider(
  provider: ProviderId,
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 5000
): Promise<{
  authenticated: boolean | null;
  authenticationError: string | null;
  models: string[];
  supportsAcp: boolean;
}> {
  if (provider !== 'cursor') {
    const status = await readCommand(
      executablePath,
      provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'],
      env,
      timeoutMs
    );
    const explicitlySignedOut = /not (?:logged in|authenticated)|login required|sign in required/i.test(status.output);
    const authenticated = status.code === 0 ? true : explicitlySignedOut ? false : null;
    return {
      authenticated,
      authenticationError: authenticated === false ? firstLine(status.output) || `${provider} is not authenticated.` : null,
      models: [],
      supportsAcp: false
    };
  }

  const [status, help] = await Promise.all([
    readCommand(executablePath, ['status'], env, timeoutMs),
    readCommand(executablePath, ['--help'], env, timeoutMs)
  ]);
  const explicitlySignedOut = /not (?:logged in|authenticated)|login required|sign in required/i.test(status.output);
  const authenticated = status.code === 0 ? true : explicitlySignedOut ? false : null;
  const modelResult = authenticated
    ? await readCommand(executablePath, ['--list-models'], env, timeoutMs)
    : { code: 1, output: '' };
  return {
    authenticated,
    authenticationError: authenticated === false ? firstLine(status.output) || 'Cursor Agent is not authenticated.' : null,
    models: modelResult.code === 0 ? parseCursorModels(modelResult.output) : [],
    supportsAcp: /(?:^|\s)acp(?:\s|$)/im.test(help.output)
  };
}

function readCommand(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(executablePath, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ code, output: output.trim() });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      finish(null);
    }, timeoutMs);
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_VERSION_OUTPUT) output = (output + chunk.toString()).slice(0, MAX_VERSION_OUTPUT);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}

function parseCursorModels(output: string): string[] {
  const values = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .map((line) => {
      if (!line || /^(available models|model)$/i.test(line)) return '';
      return /^(\S+)\s+-\s+/.exec(line)?.[1] ?? (/^\S+$/.test(line) ? line : '');
    })
    .filter(Boolean);
  return [...new Set(values)].slice(0, 100);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}
