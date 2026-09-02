import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { stat } from 'node:fs/promises';
import { spawn as spawnChild } from 'node:child_process';
import type { Logger } from 'pino';
import * as nodePty from 'node-pty';
import type {
  OperationResult,
  ProviderId,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalReplay,
  TerminalSnapshot,
  TerminalSpawnRequest
} from '../shared/contracts';
import { personNameForSeed } from '../shared/agentIdentity';
import { resolveProviderExecutable } from './providers';
import { providerAdapter } from './providerAdapters';
import { TerminalBuffer } from './terminalBuffer';

const MAX_LIVE_TERMINALS = 12;
const MAX_RETAINED_TERMINALS = 64;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 5;
const MAX_ROWS = 300;
const FORCE_KILL_AFTER_MS = 2500;
const MAX_SUBMISSION_BYTES = 128 * 1024;
const SUBMISSION_ENTER_DELAY_MS = 80;

interface TerminalSession {
  snapshot: TerminalSnapshot;
  pty: nodePty.IPty | null;
  buffer: TerminalBuffer;
  writeTail: Promise<void>;
  forceKillTimer: NodeJS.Timeout | null;
}

export interface PtyManagerOptions {
  logger: Logger;
  onData?: (event: TerminalDataEvent) => void;
  onExit?: (event: TerminalExitEvent) => void;
}

export class PtyManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private orchestratorSpawn: Promise<TerminalSnapshot> | null = null;

  constructor(private readonly options: PtyManagerOptions) {}

  list(): TerminalSnapshot[] {
    return [...this.sessions.values()]
      .map((session) => ({ ...session.snapshot }))
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async spawn(request: TerminalSpawnRequest): Promise<TerminalSnapshot> {
    this.validateSpawnRequest(request);
    if (request.role === 'orchestrator') {
      const existing = [...this.sessions.values()].find(
        (session) => session.snapshot.role === 'orchestrator' && session.pty !== null
      );
      if (existing) return { ...existing.snapshot };
      if (this.orchestratorSpawn) return this.orchestratorSpawn;
      const pending = this.spawnSession(request);
      this.orchestratorSpawn = pending;
      try {
        return await pending;
      } finally {
        if (this.orchestratorSpawn === pending) this.orchestratorSpawn = null;
      }
    }
    return this.spawnSession(request);
  }

  private async spawnSession(request: TerminalSpawnRequest): Promise<TerminalSnapshot> {
    this.pruneExitedSessions();
    const liveCount = [...this.sessions.values()].filter((session) => session.pty !== null).length;
    if (liveCount >= MAX_LIVE_TERMINALS) {
      throw new Error(`The terminal limit of ${MAX_LIVE_TERMINALS} has been reached.`);
    }

    const cwd = request.cwd.trim();
    if (!isAbsolute(cwd)) throw new Error('The terminal working directory must be absolute.');
    const cwdInfo = await stat(cwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);

    const command = providerAdapter(request.provider).command;
    const executable = await resolveProviderExecutable(request.provider);
    if (!executable) throw new Error(`${command} is not installed or is not available on PATH.`);

    const id = `${request.provider}-${randomUUID().slice(0, 8)}`;
    const cols = clampDimension(request.cols, 120, MIN_COLS, MAX_COLS);
    const rows = clampDimension(request.rows, 32, MIN_ROWS, MAX_ROWS);
    const createdAt = Date.now();
    const child = nodePty.spawn(executable, request.args ?? [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: terminalEnvironment()
    });

    const session: TerminalSession = {
      snapshot: {
        id,
        role: request.role ?? 'worker',
        avatarSeed: cleanSeed(request.avatarSeed) || id,
        name: cleanName(request.name) || personNameForSeed(id),
        provider: request.provider,
        command: executable,
        cwd,
        pid: child.pid,
        cols,
        rows,
        status: 'starting',
        createdAt,
        lastOutputAt: 0,
        hasOutput: false,
        lastSequence: 0,
        outputMode: request.outputMode ?? 'terminal'
      },
      pty: child,
      buffer: new TerminalBuffer(),
      writeTail: Promise.resolve(),
      forceKillTimer: null
    };

    this.sessions.set(id, session);
    child.onData((data) => this.handleData(id, child, data));
    child.onExit(({ exitCode, signal }) => this.handleExit(id, child, exitCode, signal));
    this.options.logger.info(
      { terminalId: id, provider: request.provider, pid: child.pid, cwd },
      'Terminal spawned'
    );
    return { ...session.snapshot };
  }

  replay(id: string): TerminalReplay {
    const session = this.requireSession(id);
    return {
      data: session.buffer.read(),
      lastSequence: session.snapshot.lastSequence
    };
  }

  async write(id: string, data: string): Promise<OperationResult> {
    if (typeof data !== 'string' || data.length === 0) return { ok: false, error: 'No terminal input was provided.' };
    if (data.length > 256 * 1024) return { ok: false, error: 'Terminal input exceeds the 256 KB limit.' };
    const session = this.sessions.get(id);
    if (!session?.pty) return { ok: false, error: `Terminal is not running: ${id}` };
    const target = session.pty;

    const next = session.writeTail
      .catch(() => undefined)
      .then(() => {
        if (session.pty !== target) throw new Error(`Terminal exited before input could be delivered: ${id}`);
        target.write(data);
      });
    session.writeTail = next;

    try {
      await next;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async submit(id: string, text: string): Promise<OperationResult> {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'No terminal submission was provided.' };
    if (Buffer.byteLength(text, 'utf8') > MAX_SUBMISSION_BYTES) {
      return { ok: false, error: 'Terminal submission exceeds the 128 KB limit.' };
    }
    const session = this.sessions.get(id);
    if (!session?.pty) return { ok: false, error: `Terminal is not running: ${id}` };
    const target = session.pty;
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text;

    const next = session.writeTail
      .catch(() => undefined)
      .then(async () => {
        if (session.pty !== target) throw new Error(`Terminal exited before input could be delivered: ${id}`);
        target.write(payload);
        await delay(SUBMISSION_ENTER_DELAY_MS);
        if (session.pty !== target) throw new Error(`Terminal exited before input could be submitted: ${id}`);
        target.write('\r');
      });
    session.writeTail = next;

    try {
      await next;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  resize(id: string, cols: number, rows: number): OperationResult {
    const session = this.sessions.get(id);
    if (!session?.pty) return { ok: false, error: `Terminal is not running: ${id}` };
    const safeCols = clampDimension(cols, session.snapshot.cols, MIN_COLS, MAX_COLS);
    const safeRows = clampDimension(rows, session.snapshot.rows, MIN_ROWS, MAX_ROWS);
    try {
      session.pty.resize(safeCols, safeRows);
      session.snapshot.cols = safeCols;
      session.snapshot.rows = safeRows;
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  interrupt(id: string): Promise<OperationResult> {
    return this.write(id, '\x03');
  }

  stop(id: string, force = false): OperationResult {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: `Unknown terminal: ${id}` };
    if (!session.pty) return { ok: true };

    session.snapshot.status = 'stopping';
    this.killProcessTree(session, force ? 'SIGKILL' : 'SIGTERM');
    if (!force && !session.forceKillTimer) {
      session.forceKillTimer = setTimeout(() => {
        session.forceKillTimer = null;
        if (session.pty) this.killProcessTree(session, 'SIGKILL');
      }, FORCE_KILL_AFTER_MS);
      session.forceKillTimer.unref();
    }
    return { ok: true };
  }

  dismiss(id: string): OperationResult {
    const session = this.sessions.get(id);
    if (!session) return { ok: true };
    if (session.pty) return { ok: false, error: 'Stop the terminal before dismissing it.' };
    this.sessions.delete(id);
    return { ok: true };
  }

  stopAll(): void {
    for (const session of this.sessions.values()) {
      if (session.pty) this.killProcessTree(session, 'SIGKILL');
      if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
      session.forceKillTimer = null;
    }
  }

  private pruneExitedSessions(): void {
    if (this.sessions.size < MAX_RETAINED_TERMINALS) return;
    const exited = [...this.sessions.values()]
      .filter((session) => session.pty === null)
      .sort((left, right) => (left.snapshot.exitedAt ?? 0) - (right.snapshot.exitedAt ?? 0));
    for (const session of exited) {
      if (this.sessions.size < MAX_RETAINED_TERMINALS) break;
      this.sessions.delete(session.snapshot.id);
    }
  }

  private handleData(id: string, owner: nodePty.IPty, data: string): void {
    const session = this.sessions.get(id);
    if (!session || session.pty !== owner) return;
    session.buffer.append(data);
    session.snapshot.hasOutput = true;
    session.snapshot.lastOutputAt = Date.now();
    session.snapshot.lastSequence += 1;
    if (session.snapshot.status === 'starting') session.snapshot.status = 'running';
    this.options.onData?.({ id, data, sequence: session.snapshot.lastSequence });
  }

  private handleExit(id: string, owner: nodePty.IPty, exitCode: number, signal?: number): void {
    const session = this.sessions.get(id);
    if (!session || session.pty !== owner) return;
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
    session.forceKillTimer = null;
    session.pty = null;
    const exitedAt = Date.now();
    session.snapshot.status = 'exited';
    session.snapshot.exitCode = exitCode;
    session.snapshot.exitSignal = signal;
    session.snapshot.exitedAt = exitedAt;
    this.options.logger.info({ terminalId: id, exitCode, signal }, 'Terminal exited');
    this.options.onExit?.({ id, exitCode, signal, exitedAt });
  }

  private killProcessTree(session: TerminalSession, signal: 'SIGTERM' | 'SIGKILL'): void {
    const terminal = session.pty;
    if (!terminal) return;
    try {
      if (process.platform === 'win32') {
        const args = ['/pid', String(terminal.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])];
        const killer = spawnChild('taskkill', args, { stdio: 'ignore', windowsHide: true });
        killer.unref();
      } else {
        try {
          process.kill(-terminal.pid, signal);
        } catch {
          terminal.kill(signal);
        }
      }
    } catch (error) {
      this.options.logger.warn(
        { terminalId: session.snapshot.id, pid: terminal.pid, signal, error },
        'Terminal process-tree termination failed'
      );
      try { terminal.kill(signal); } catch { /* Process already exited. */ }
    }
  }

  private requireSession(id: string): TerminalSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown terminal: ${id}`);
    return session;
  }

  private validateSpawnRequest(request: TerminalSpawnRequest): void {
    if (!request || !['claude', 'codex', 'cursor'].includes(request.provider)) throw new Error('Unsupported terminal provider.');
    if (typeof request.cwd !== 'string' || !request.cwd.trim()) throw new Error('A working directory is required.');
    if (request.name !== undefined && (typeof request.name !== 'string' || request.name.length > 80)) {
      throw new Error('Terminal names must be at most 80 characters.');
    }
    if (request.role !== undefined && !['worker', 'orchestrator', 'planner', 'synthesizer', 'verifier'].includes(request.role)) {
      throw new Error('Unsupported terminal role.');
    }
    if (request.avatarSeed !== undefined && (typeof request.avatarSeed !== 'string' || request.avatarSeed.length > 128)) {
      throw new Error('Avatar seeds must be at most 128 characters.');
    }
    if (request.outputMode !== undefined && !['terminal', 'event-stream'].includes(request.outputMode)) {
      throw new Error('Unsupported terminal output mode.');
    }
    if (request.args !== undefined) {
      if (!Array.isArray(request.args) || request.args.length > 64) throw new Error('Too many terminal arguments.');
      if (request.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)) {
        throw new Error('Terminal arguments must be strings shorter than 4096 characters.');
      }
    }
  }
}

const TERMINAL_ENV_KEYS = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN',
  'CURSOR_API_ENDPOINT', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'
]);

export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && (TERMINAL_ENV_KEYS.has(key) || key.startsWith('LC_'))) {
      environment[key] = value;
    }
  }
  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.TERM_PROGRAM = 'Relay';
  return environment;
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value!)));
}

function cleanName(value: string | undefined): string {
  return (value ?? '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 80);
}

function cleanSeed(value: string | undefined): string {
  return (value ?? '').trim().replace(/[\r\n\t]+/g, '-').slice(0, 128);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
