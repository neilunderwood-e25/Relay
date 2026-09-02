import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ProviderId } from '../shared/contracts';
import { resolveProviderExecutable } from './providers';

const SESSION_LOOKUP_TIMEOUT_MS = 10_000;
const SESSION_LOOKUP_INTERVAL_MS = 250;
const SESSION_CLOCK_SKEW_MS = 2 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CREATE_SESSION_TIMEOUT_MS = 15_000;

export interface NativeSessionLookupOptions {
  claudeHome?: string;
  codexHome?: string;
  cursorHome?: string;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export interface NativeSessionResultOptions extends NativeSessionLookupOptions {
  requiredMarker?: string;
}

/** Reads the last assistant turn from a provider's structured session transcript. */
export async function readNativeWorkerResult(
  provider: ProviderId,
  cwd: string,
  nativeSessionId: string,
  startedAt: number,
  options: NativeSessionResultOptions = {}
): Promise<string | undefined> {
  if (!UUID_PATTERN.test(nativeSessionId)) return undefined;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, timeoutMs);
  let latest: string | undefined;
  do {
    const transcript = await nativeTranscriptPath(provider, cwd, nativeSessionId, startedAt, options);
    if (transcript) {
      const contents = await readFile(transcript, 'utf8').catch(() => '');
      latest = extractLastAssistantTurn(provider, contents) ?? latest;
      if (latest && (!options.requiredMarker || latest.includes(options.requiredMarker))) return latest;
    }
    if (now() >= deadline) return latest;
    await delay(intervalMs);
  } while (now() <= deadline);
  return latest;
}

export async function resolveNativeWorkerSessionId(
  provider: ProviderId,
  cwd: string,
  startedAt: number,
  options: NativeSessionLookupOptions = {}
): Promise<string | undefined> {
  if (provider !== 'codex' && provider !== 'cursor') return undefined;
  const timeoutMs = options.timeoutMs ?? SESSION_LOOKUP_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SESSION_LOOKUP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, timeoutMs);
  do {
    const found = provider === 'codex'
      ? await findCodexSessionId(cwd, startedAt, options.codexHome)
      : await findCursorSessionId(cwd, startedAt, options.cursorHome);
    if (found) return found;
    if (now() >= deadline) return undefined;
    await delay(intervalMs);
  } while (now() <= deadline);
  return undefined;
}

/** Pre-allocates a durable Cursor chat so Relay knows its identity before the interactive PTY starts. */
export async function createNativeWorkerSessionId(
  provider: ProviderId,
  cwd: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<string | undefined> {
  if (provider !== 'cursor') return undefined;
  const executable = await resolveProviderExecutable('cursor', options.env);
  if (!executable) throw new Error('Cursor Agent is not installed or is not available on PATH.');
  return new Promise((resolveId, reject) => {
    const child = spawn(executable, ['create-chat'], {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      finish(() => reject(new Error('Cursor chat creation timed out.')));
    }, options.timeoutMs ?? CREATE_SESSION_TIMEOUT_MS);
    const append = (chunk: Buffer): void => {
      if (output.length < 64 * 1024) output = (output + chunk.toString()).slice(0, 64 * 1024);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => finish(() => {
      const id = output.split(/\s+/).find((value) => UUID_PATTERN.test(value));
      if (code === 0 && id) resolveId(id);
      else reject(new Error(output.trim() || `Cursor chat creation exited with code ${code ?? 'unknown'}.`));
    }));
  });
}

async function findCursorSessionId(
  cwd: string,
  startedAt: number,
  configuredHome?: string
): Promise<string | undefined> {
  const projectRoot = join(configuredHome ?? join(homedir(), '.cursor'), 'projects');
  const canonicalCwd = await canonicalPath(cwd);
  const candidates: Array<{ id: string; modifiedAt: number }> = [];
  for (const slug of cursorProjectSlugs(canonicalCwd)) {
    const transcriptsRoot = join(projectRoot, slug, 'agent-transcripts');
    const entries = await readdir(transcriptsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
      const transcript = join(transcriptsRoot, entry.name, `${entry.name}.jsonl`);
      const info = await stat(transcript).catch(() => null);
      if (!info || info.mtimeMs < startedAt - SESSION_CLOCK_SKEW_MS) continue;
      candidates.push({ id: entry.name, modifiedAt: info.mtimeMs });
    }
  }
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0]?.id;
}

async function nativeTranscriptPath(
  provider: ProviderId,
  cwd: string,
  nativeSessionId: string,
  startedAt: number,
  options: NativeSessionResultOptions
): Promise<string | undefined> {
  const canonicalCwd = await canonicalPath(cwd);
  if (provider === 'claude') {
    const projectRoot = join(options.claudeHome ?? join(homedir(), '.claude'), 'projects');
    const path = join(projectRoot, claudeProjectSlug(canonicalCwd), `${nativeSessionId}.jsonl`);
    return await stat(path).then(() => path).catch(() => undefined);
  }
  if (provider === 'cursor') {
    const projectRoot = join(options.cursorHome ?? join(homedir(), '.cursor'), 'projects');
    for (const slug of cursorProjectSlugs(canonicalCwd)) {
      const path = join(projectRoot, slug, 'agent-transcripts', nativeSessionId, `${nativeSessionId}.jsonl`);
      if (await stat(path).then(() => true).catch(() => false)) return path;
    }
    return undefined;
  }
  return findCodexSessionFile(canonicalCwd, nativeSessionId, startedAt, options.codexHome);
}

function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9_-]/g, '-');
}

function cursorProjectSlugs(cwd: string): string[] {
  const path = resolve(cwd).replace(/^[/\\]+/, '');
  return [...new Set([
    path.replace(/[/\\:]/g, '-'),
    path.replace(/[^A-Za-z0-9_-]/g, '-')
  ])];
}

async function findCodexSessionId(
  cwd: string,
  startedAt: number,
  configuredHome?: string
): Promise<string | undefined> {
  const file = await findCodexSessionFile(cwd, undefined, startedAt, configuredHome);
  if (!file) return undefined;
  try {
    const firstLine = (await readFile(file, 'utf8')).split('\n', 1)[0];
    const record = JSON.parse(firstLine) as { payload?: { session_id?: string; id?: string } };
    return record.payload?.session_id ?? record.payload?.id;
  } catch {
    return undefined;
  }
}

async function findCodexSessionFile(
  cwd: string,
  nativeSessionId: string | undefined,
  startedAt: number,
  configuredHome?: string
): Promise<string | undefined> {
  const sessionRoot = join(configuredHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  const target = await canonicalPath(cwd);
  const files = await candidateSessionFiles(sessionRoot, startedAt);
  for (const file of files) {
    try {
      const firstLine = (await readFile(file, 'utf8')).split('\n', 1)[0];
      if (!firstLine) continue;
      const record = JSON.parse(firstLine) as {
        type?: string;
        payload?: { session_id?: string; id?: string; cwd?: string };
      };
      if (record.type !== 'session_meta' || typeof record.payload?.cwd !== 'string') continue;
      const id = record.payload.session_id ?? record.payload.id;
      if (!id || !UUID_PATTERN.test(id)) continue;
      if (nativeSessionId && id !== nativeSessionId) continue;
      if (await canonicalPath(record.payload.cwd) === target) return file;
    } catch {
      // A newly-created rollout can be empty or between writes. The next poll retries it.
    }
  }
  return undefined;
}

function extractLastAssistantTurn(provider: ProviderId, contents: string): string | undefined {
  let turn: string[] = [];
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (provider === 'codex') {
        const payload = asRecord(record.payload);
        const item = asRecord(payload?.item);
        if (record.type === 'event_msg' && payload?.type === 'item_completed' && item?.type === 'UserMessage') {
          turn = [];
        } else if (record.type === 'event_msg' && payload?.type === 'item_completed' && item?.type === 'AgentMessage') {
          turn.push(...textContent(item.content));
        }
        continue;
      }

      const message = asRecord(record.message);
      const role = typeof record.role === 'string' ? record.role : message?.role;
      if (role === 'user') turn = [];
      else if (role === 'assistant') turn.push(...textContent(message?.content));
    } catch {
      // Providers can leave a partial JSONL line while flushing; a retry will read it later.
    }
  }
  const result = turn.map((part) => part.trim()).filter(Boolean).join('\n\n').trim();
  return result || undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textContent(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const block = asRecord(entry);
    if (!block || (block.type !== 'text' && block.type !== 'Text')) return [];
    return typeof block.text === 'string' ? [block.text] : [];
  });
}

async function candidateSessionFiles(root: string, startedAt: number): Promise<string[]> {
  const directories = new Set<string>();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(startedAt + offset);
    directories.add(join(
      root,
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ));
  }
  const files: Array<{ path: string; modifiedAt: number }> = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(directory, entry.name);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < startedAt - SESSION_CLOCK_SKEW_MS) continue;
      files.push({ path, modifiedAt: info.mtimeMs });
    }
  }
  return files.sort((left, right) => right.modifiedAt - left.modifiedAt).map(({ path }) => path);
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(resolve(path)).catch(() => resolve(path));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, milliseconds)));
}
