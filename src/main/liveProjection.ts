import type {
  OrchestrationSnapshot,
  OrchestratorProjectionEventKind,
  OrchestratorProjectionSnapshot,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSnapshot
} from '../shared/contracts';

const MAX_RAW_CHARACTERS = 64 * 1024;
const MAX_LINES = 8;
const MAX_LINE_CHARACTERS = 240;
const MAX_EVENTS = 6;
const EMIT_THROTTLE_MS = 80;
const QUIET_WINDOW_MS = 1_500;
const ANSI_PATTERN = /\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g;

export interface LiveMonitorProjectionOptions {
  onUpdate(snapshot: OrchestratorProjectionSnapshot): void;
  now?: () => number;
}

/** A bounded, plain-text projection of the one persistent orchestrator PTY. */
export class LiveMonitorProjection {
  private state: OrchestratorProjectionSnapshot = {
    terminalId: null,
    status: 'starting',
    updatedAt: 0,
    lastSequence: 0,
    lines: [],
    events: []
  };
  private raw = '';
  private linesDirty = false;
  private eventSequence = 0;
  private readonly busyCommands = new Set<string>();
  private emitTimer: NodeJS.Timeout | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private readonly runStatuses = new Map<string, string>();

  constructor(private readonly options: LiveMonitorProjectionOptions) {}

  snapshot(): OrchestratorProjectionSnapshot {
    this.refreshLines();
    return cloneSnapshot(this.state);
  }

  attach(terminal: TerminalSnapshot, replay = ''): void {
    const changed = terminal.id !== this.state.terminalId;
    if (changed) {
      this.raw = replay.slice(-MAX_RAW_CHARACTERS);
      this.busyCommands.clear();
      this.state.lines = projectTerminalLines(this.raw);
      this.linesDirty = false;
      this.record('system', 'Session started', false);
    } else if (replay && !this.raw) {
      this.raw = replay.slice(-MAX_RAW_CHARACTERS);
      this.state.lines = projectTerminalLines(this.raw);
      this.linesDirty = false;
    }
    this.state.terminalId = terminal.id;
    this.state.lastSequence = Math.max(this.state.lastSequence, terminal.lastSequence);
    this.state.status = terminal.status === 'exited'
      ? 'stopped'
      : terminal.status === 'starting'
        ? 'starting'
        : this.busyCommands.size > 0 ? 'working' : 'ready';
    this.touch();
    this.emitSoon();
  }

  handleData(event: TerminalDataEvent): void {
    if (!this.state.terminalId || event.id !== this.state.terminalId) return;
    this.raw = `${this.raw}${event.data}`.slice(-MAX_RAW_CHARACTERS);
    this.linesDirty = true;
    this.state.lastSequence = Math.max(this.state.lastSequence, event.sequence);
    this.state.status = 'working';
    this.touch();
    this.armQuietWindow();
    this.emitSoon();
  }

  handleExit(event: TerminalExitEvent): void {
    if (event.id !== this.state.terminalId) return;
    this.busyCommands.clear();
    this.state.status = event.exitCode === 0 ? 'stopped' : 'error';
    this.record('system', event.exitCode === 0 ? 'Session stopped' : 'Session failed', false);
    this.touch(event.exitedAt);
    this.emitSoon();
  }

  begin(commandId: string, label = 'Michael working'): void {
    this.busyCommands.add(commandId);
    this.state.status = 'working';
    this.record('input', label, false);
    this.touch();
    this.emitSoon();
  }

  end(commandId: string, failed = false): void {
    this.busyCommands.delete(commandId);
    this.state.status = failed ? 'error' : this.busyCommands.size > 0 ? 'working' : 'ready';
    if (failed) this.record('system', 'Delivery failed', false);
    this.touch();
    this.emitSoon();
  }

  record(kind: OrchestratorProjectionEventKind, label: string, emit = true): void {
    const clean = label.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean) return;
    const latest = this.state.events.at(-1);
    if (latest?.kind === kind && latest.label === clean) return;
    const createdAt = this.now();
    this.state.events = [...this.state.events, {
      id: `projection-${createdAt}-${++this.eventSequence}`,
      kind,
      label: clean,
      createdAt
    }].slice(-MAX_EVENTS);
    this.touch(createdAt);
    if (emit) this.emitSoon();
  }

  recordRun(snapshot: OrchestrationSnapshot): void {
    const previous = this.runStatuses.get(snapshot.run.id);
    if (previous === snapshot.run.status) return;
    this.runStatuses.set(snapshot.run.id, snapshot.run.status);
    const label = runStatusLabel(snapshot.run.status);
    if (label) this.record('run', label);
  }

  dispose(): void {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.emitTimer = null;
    this.quietTimer = null;
    this.busyCommands.clear();
  }

  private armQuietWindow(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (this.state.status === 'working' && this.busyCommands.size === 0) {
        this.state.status = 'ready';
        this.touch();
        this.emitSoon();
      }
    }, QUIET_WINDOW_MS);
    this.quietTimer.unref();
  }

  private emitSoon(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.options.onUpdate(this.snapshot());
    }, EMIT_THROTTLE_MS);
    this.emitTimer.unref();
  }

  private refreshLines(): void {
    if (!this.linesDirty) return;
    this.state.lines = projectTerminalLines(this.raw);
    this.linesDirty = false;
  }

  private touch(at = this.now()): void {
    this.state.updatedAt = at;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function projectTerminalLines(value: string): string[] {
  const lines: string[] = [];
  let current = '';
  const clean = value
    .replace(ANSI_PATTERN, '')
    .replace(/\x1B[()][A-Z0-9]/g, '')
    .replace(/[\u0000-\u0007\u000B\u000C\u000E-\u001F\u007F]/g, '');
  for (const character of clean) {
    if (character === '\r') {
      current = '';
    } else if (character === '\n') {
      pushLine(lines, current);
      current = '';
    } else if (character === '\b') {
      current = current.slice(0, -1);
    } else {
      current += character === '\t' ? '  ' : character;
    }
  }
  pushLine(lines, current);
  return lines.slice(-MAX_LINES);
}

function pushLine(lines: string[], value: string): void {
  const line = value
    .replace(/^[\s│┃║╭╮╰╯┌┐└┘─━═]+|[\s│┃║╭╮╰╯┌┐└┘─━═]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LINE_CHARACTERS);
  if (!line || /^[·•⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$/.test(line) || lines.at(-1) === line) return;
  lines.push(line);
}

function runStatusLabel(status: OrchestrationSnapshot['run']['status']): string | null {
  if (status === 'planning') return 'Planning run';
  if (status === 'queued') return 'Team queued';
  if (status === 'running') return 'Team working';
  if (status === 'summarizing') return 'Reviewing results';
  if (status === 'completed') return 'Run complete';
  if (status === 'blocked') return 'Run blocked';
  if (status === 'failed') return 'Run failed';
  if (status === 'stopped') return 'Run stopped';
  return null;
}

function cloneSnapshot(snapshot: OrchestratorProjectionSnapshot): OrchestratorProjectionSnapshot {
  return {
    ...snapshot,
    lines: [...snapshot.lines],
    events: snapshot.events.map((event) => ({ ...event }))
  };
}
