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
  versionArgs: string[];
}

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  const executablePath = await resolveExecutable(definition.command, options.env);
  if (!executablePath) {
    return {
      id: definition.id,
      label: definition.label,
      command: definition.command,
      available: false,
      executablePath: null,
      version: null,
      error: `${definition.label} is not installed or is not available on PATH.`
    };
  }

  try {
    const version = await readVersion(executablePath, definition.versionArgs, options.env, options.timeoutMs);
    return {
      id: definition.id,
      label: definition.label,
      command: definition.command,
      available: true,
      executablePath,
      version,
      error: null
    };
  } catch (error) {
    return {
      id: definition.id,
      label: definition.label,
      command: definition.command,
      available: false,
      executablePath,
      version: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function detectProviders(): Promise<ProviderCapability[]> {
  return Promise.all(providerAdapters().map((provider) => detectProvider(provider)));
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

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
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
