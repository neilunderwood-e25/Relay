import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import type { ProviderId } from '../shared/contracts';

const SESSION_LOOKUP_TIMEOUT_MS = 10_000;
const SESSION_LOOKUP_INTERVAL_MS = 250;
const SESSION_CLOCK_SKEW_MS = 2 * 60_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NativeSessionLookupOptions {
  codexHome?: string;
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
}

export async function resolveNativeWorkerSessionId(
  provider: ProviderId,
  cwd: string,
  startedAt: number,
  options: NativeSessionLookupOptions = {}
): Promise<string | undefined> {
  if (provider !== 'codex') return undefined;
  const timeoutMs = options.timeoutMs ?? SESSION_LOOKUP_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? SESSION_LOOKUP_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(0, timeoutMs);
  do {
    const found = await findCodexSessionId(cwd, startedAt, options.codexHome);
    if (found) return found;
    if (now() >= deadline) return undefined;
    await delay(intervalMs);
  } while (now() <= deadline);
  return undefined;
}

async function findCodexSessionId(
  cwd: string,
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
      if (await canonicalPath(record.payload.cwd) === target) return id;
    } catch {
      // A newly-created rollout can be empty or between writes. The next poll retries it.
    }
  }
  return undefined;
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
