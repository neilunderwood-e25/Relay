import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HiveHealth,
  OrchestrationSnapshot,
  OrchestrationTaskStatus,
  ProviderId
} from '../shared/contracts';
import { personNameForSeed } from '../shared/agentIdentity';
import { orchestratorModelLabel } from '../shared/orchestratorModels';

interface HiveRegistry {
  version: 1;
  orchestratorId: 'orchestrator';
  agents: Record<string, {
    id: string;
    name: string;
    role: string;
    status: 'idle' | 'working' | 'blocked';
    directory: string;
    lastSeen: number;
  }>;
}

interface HiveLedger {
  version: 1;
  tasks: HiveTaskCard[];
}

interface HiveTaskCard {
  id: string;
  runId: string;
  source: string;
  title: string;
  description: string;
  deliverable: string;
  assignee: string;
  provider: string;
  role: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  branch?: string;
  worktreePath?: string;
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function protocol(orchestratorName: string): string {
  return `# Relay hive protocol

The hive is Relay's durable coordination space. The Electron main process owns shared files.

## ${orchestratorName} workspace

- \`identity.md\` defines the orchestrator role.
- \`memory.md\` stores durable decisions and context.
- \`inbox/\` receives messages; handled messages move to \`inbox/.done/\`.
- \`outbox/\` holds outgoing messages; delivered messages move to \`outbox/.sent/\`.

## Shared state

- \`registry.json\` is the agent roster.
- \`board.md\` is ${orchestratorName}'s narrative plan.
- \`tasks.json\` is the structured task ledger.
- \`log.jsonl\` is the append-only event stream.

Workers must never write into another agent's directory. Relay will add message routing in a later phase.
`;
}

export class HiveManager {
  private ready = false;
  private error: string | undefined;
  private currentStatus: 'idle' | 'working' | 'blocked' = 'idle';

  constructor(
    readonly root: string,
    private orchestratorName: string,
    private orchestratorProvider: ProviderId = 'claude',
    private orchestratorModel: string | null = null
  ) {}

  get agentRoot(): string {
    return join(this.root, 'agents', 'orchestrator');
  }

  ensure(): HiveHealth {
    try {
      const legacyRoot = join(this.root, 'agents', 'rehan');
      if (existsSync(legacyRoot) && !existsSync(this.agentRoot)) renameSync(legacyRoot, this.agentRoot);
      mkdirSync(join(this.agentRoot, 'inbox', '.done'), { recursive: true });
      mkdirSync(join(this.agentRoot, 'outbox', '.sent'), { recursive: true });
      this.atomicWrite(join(this.root, 'PROTOCOL.md'), protocol(this.orchestratorName));
      this.writeIfMissing(join(this.root, 'board.md'), `# Relay board\n\n_${this.orchestratorName} owns this shared plan._\n`);
      this.migrateLegacyBoard();
      this.writeJsonIfMissing(join(this.root, 'tasks.json'), { version: 1, tasks: [] });
      this.writeIfMissing(join(this.root, 'log.jsonl'), '');
      this.writeIfMissing(
        join(this.agentRoot, 'memory.md'),
        `# ${this.orchestratorName} memory\n\n_Append durable decisions, project context, and coordination lessons here._\n`
      );
      this.writeJsonIfMissing(join(this.agentRoot, 'cursor.json'), { lastProcessed: null });
      this.writeIfMissing(join(this.agentRoot, '.gitignore'), 'settings.json\ncursor.json\ninbox/\noutbox/\n');
      this.atomicWrite(
        join(this.agentRoot, 'identity.md'),
        [
          `# ${this.orchestratorName}`,
          '',
          '- Role: Relay orchestrator',
          `- Engine: ${this.orchestratorProvider === 'claude' ? 'Claude Code' : 'Codex CLI'}`,
          `- Model: ${orchestratorModelLabel(this.orchestratorProvider, this.orchestratorModel)}`,
          '- Owns: decomposition, assignment, task tracking, integration decisions, and final QA',
          '- Delegates implementation to CLI workers in isolated Git worktrees',
          '- Shared hive: ../../',
          ''
        ].join('\n')
      );
      this.refreshRegistry('idle');
      this.appendEvent('hive.ready', { agentId: 'orchestrator', name: this.orchestratorName });
      this.ready = true;
      this.error = undefined;
    } catch (cause) {
      this.ready = false;
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
    return this.health();
  }

  health(): HiveHealth {
    return {
      ready: this.ready,
      path: this.root,
      agentPath: this.agentRoot,
      error: this.error
    };
  }

  renameOrchestrator(name: string): void {
    this.orchestratorName = name;
    if (!this.ready) return;
    this.atomicWrite(join(this.root, 'PROTOCOL.md'), protocol(this.orchestratorName));
    this.atomicWrite(
      join(this.agentRoot, 'identity.md'),
      [
        `# ${this.orchestratorName}`,
        '',
        '- Role: Relay orchestrator',
        `- Engine: ${this.orchestratorProvider === 'claude' ? 'Claude Code' : 'Codex CLI'}`,
        `- Model: ${orchestratorModelLabel(this.orchestratorProvider, this.orchestratorModel)}`,
        '- Owns: decomposition, assignment, task tracking, integration decisions, and final QA',
        '- Delegates implementation to CLI workers in isolated Git worktrees',
        '- Shared hive: ../../',
        ''
      ].join('\n')
    );
    this.refreshRegistry(this.currentStatus);
    this.appendEvent('orchestrator.renamed', { agentId: 'orchestrator', name });
  }

  syncOrchestrations(snapshots: OrchestrationSnapshot[]): void {
    if (!this.ready) return;
    const ledger = this.readJson<HiveLedger>(join(this.root, 'tasks.json'), { version: 1, tasks: [] });
    const external = ledger.tasks.filter((task) => !['relay', 'foundry'].includes(task.source));
    const tasks = snapshots.flatMap((snapshot) => snapshot.tasks.map((task): HiveTaskCard => ({
      id: task.id,
      runId: task.runId,
      source: 'relay',
      title: task.title,
      description: task.instructions,
      deliverable: task.deliverable,
      assignee: task.agentName ?? personNameForSeed(task.id),
      provider: task.provider,
      role: task.role,
      status: ledgerStatus(task.status),
      dependsOn: [],
      branch: task.branch,
      worktreePath: task.worktreePath,
      result: task.summary,
      error: task.error,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString()
    })));
    this.atomicWriteJson(join(this.root, 'tasks.json'), { version: 1, tasks: [...external, ...tasks] });

    const latest = snapshots[0]?.run;
    const status = latest && ['queued', 'running', 'stopping'].includes(latest.status)
      ? 'working'
      : latest && ['blocked', 'failed'].includes(latest.status)
        ? 'blocked'
        : 'idle';
    this.refreshRegistry(status);
  }

  appendEvent(kind: string, payload: Record<string, unknown>): void {
    if (!existsSync(this.root)) return;
    appendFileSync(join(this.root, 'log.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      ...payload
    })}\n`, 'utf8');
  }

  private refreshRegistry(status: 'idle' | 'working' | 'blocked'): void {
    this.currentStatus = status;
    const path = join(this.root, 'registry.json');
    const registry = this.readJson<HiveRegistry>(path, { version: 1, orchestratorId: 'orchestrator', agents: {} });
    registry.version = 1;
    registry.orchestratorId = 'orchestrator';
    delete registry.agents.rehan;
    registry.agents.orchestrator = {
      id: 'orchestrator',
      name: this.orchestratorName,
      role: 'orchestrator',
      status,
      directory: this.agentRoot,
      lastSeen: Date.now()
    };
    registry.agents.claude = {
      id: 'claude',
      name: 'Claude',
      role: 'CLI worker',
      status: 'idle',
      directory: '',
      lastSeen: Date.now()
    };
    registry.agents.codex = {
      id: 'codex',
      name: 'Codex',
      role: 'CLI worker',
      status: 'idle',
      directory: '',
      lastSeen: Date.now()
    };
    this.atomicWriteJson(path, registry);
  }

  private writeIfMissing(path: string, content: string): void {
    if (!existsSync(path)) this.atomicWrite(path, content);
  }

  private migrateLegacyBoard(): void {
    const path = join(this.root, 'board.md');
    const current = readFileSync(path, 'utf8');
    const migrated = current
      .replace(/^# Foundry board$/m, '# Relay board')
      .replace(/^_Rehan owns this shared plan\._$/m, `_${this.orchestratorName} owns this shared plan._`);
    if (migrated !== current) this.atomicWrite(path, migrated);
  }

  private writeJsonIfMissing(path: string, value: unknown): void {
    if (!existsSync(path)) this.atomicWriteJson(path, value);
  }

  private atomicWriteJson(path: string, value: unknown): void {
    this.atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private atomicWrite(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, path);
  }

  private readJson<T>(path: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  }
}

function ledgerStatus(status: OrchestrationTaskStatus): HiveTaskCard['status'] {
  if (status === 'completed') return 'done';
  if (['blocked', 'failed', 'stopped'].includes(status)) return 'blocked';
  if (status === 'queued') return 'todo';
  return 'doing';
}
