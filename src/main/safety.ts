import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentSession,
  OrchestrationSnapshot,
  OrchestrationTask,
  TerminalSnapshot,
  TerminalSpawnRequest,
  WorktreeRecord
} from '../shared/contracts';

interface SafetyDatabase {
  getAgentSession(id: string): AgentSession | undefined;
  getOrchestration(id: string): OrchestrationSnapshot | undefined;
  getOrchestrationTask(id: string): OrchestrationTask | undefined;
  getWorktree(id: string): WorktreeRecord | undefined;
  appendEvent(type: string, payload?: Record<string, unknown>): void;
}

export class SafetyBoundaryError extends Error {
  readonly code = 'RELAY_SAFETY_BOUNDARY';

  constructor(message: string) {
    super(message);
    this.name = 'SafetyBoundaryError';
  }
}

export class SafetyBoundary {
  constructor(
    private readonly database: SafetyDatabase,
    private readonly projectPath: () => string | null
  ) {}

  selectedProject(): string {
    const selected = this.projectPath();
    if (!selected) return this.deny('workspace', 'No project is selected.');
    return canonicalPath(selected);
  }

  assertProjectPath(candidate: unknown, operation: string): string {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      return this.deny(operation, 'A project path is required.');
    }
    const selected = this.selectedProject();
    const requested = canonicalPath(candidate);
    if (requested !== selected) {
      return this.deny(operation, 'The request is outside the selected project.');
    }
    return selected;
  }

  assertRun(runId: unknown, operation: string): OrchestrationSnapshot {
    if (typeof runId !== 'string' || !runId) return this.deny(operation, 'A run id is required.');
    const snapshot = this.database.getOrchestration(runId);
    if (!snapshot) return this.deny(operation, 'The run was not found.');
    this.assertProjectPath(snapshot.run.repoRoot, operation);
    return snapshot;
  }

  assertTask(taskId: unknown, operation: string): OrchestrationTask {
    if (typeof taskId !== 'string' || !taskId) return this.deny(operation, 'A task id is required.');
    const task = this.database.getOrchestrationTask(taskId);
    if (!task) return this.deny(operation, 'The task was not found.');
    this.assertRun(task.runId, operation);
    return task;
  }

  assertAgentSession(sessionId: unknown, operation: string): AgentSession {
    if (typeof sessionId !== 'string' || !sessionId) {
      return this.deny(operation, 'An agent session id is required.');
    }
    const session = this.database.getAgentSession(sessionId);
    if (!session) return this.deny(operation, 'The agent session was not found.');
    this.assertRun(session.runId, operation);
    return session;
  }

  assertWorktree(worktreeId: unknown, operation: string): WorktreeRecord | undefined {
    if (typeof worktreeId !== 'string' || !worktreeId) {
      return this.deny(operation, 'A worktree id is required.');
    }
    const record = this.database.getWorktree(worktreeId);
    if (record) this.assertProjectPath(record.repoRoot, operation);
    return record;
  }

  assertRendererTerminal(request: unknown, allowedDirectories: string[]): TerminalSpawnRequest {
    const operation = 'terminal.spawn';
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return this.deny(operation, 'Invalid terminal request.');
    }
    const terminal = request as TerminalSpawnRequest;
    if (terminal.role !== undefined && terminal.role !== 'worker') {
      return this.deny(operation, 'Renderer terminals cannot assume a privileged role.');
    }
    if (terminal.args !== undefined) {
      return this.deny(operation, 'Renderer terminals cannot supply CLI arguments.');
    }
    if (terminal.outputMode !== undefined && terminal.outputMode !== 'terminal') {
      return this.deny(operation, 'Renderer terminals cannot use an internal output mode.');
    }
    if (typeof terminal.cwd !== 'string') return this.deny(operation, 'A working directory is required.');
    const cwd = canonicalPath(terminal.cwd);
    const allowed = new Set(allowedDirectories.map(canonicalPath));
    if (!allowed.has(cwd)) {
      return this.deny(operation, 'The terminal directory is outside the selected project worktrees.');
    }
    return { ...terminal, role: 'worker', cwd, args: undefined, outputMode: 'terminal' };
  }

  assertRendererTerminalControl(terminal: TerminalSnapshot | undefined, operation: string): TerminalSnapshot {
    if (!terminal) return this.deny(operation, 'The terminal was not found.');
    if (!['worker', 'orchestrator'].includes(terminal.role ?? 'worker')) {
      return this.deny(operation, 'Internal Relay terminals cannot be controlled directly.');
    }
    if ((terminal.outputMode ?? 'terminal') !== 'terminal') {
      return this.deny(operation, 'Event-stream terminals cannot be controlled directly.');
    }
    return terminal;
  }

  assertRendererTerminalView(terminal: TerminalSnapshot | undefined, operation: string): TerminalSnapshot {
    if (!terminal) return this.deny(operation, 'The terminal was not found.');
    return terminal;
  }

  private deny(operation: string, reason: string): never {
    this.database.appendEvent('app.safety.denied', { operation, reason });
    throw new SafetyBoundaryError(reason);
  }
}

export function canonicalPath(path: string): string {
  const candidate = resolve(path.trim());
  try {
    return realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}
