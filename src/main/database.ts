import Database from 'better-sqlite3';
import type {
  ActivityCategory,
  ActivityEvent,
  ActivityListRequest,
  ActivityPage,
  DatabaseHealth,
  OrchestrationRun,
  OrchestrationSnapshot,
  OrchestrationTask,
  WorktreeRecord
} from '../shared/contracts';

type Migration = (database: Database.Database) => void;

const MIGRATIONS: Migration[] = [
  (database) => {
    database.exec(`
      CREATE TABLE app_kv (
        key        TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at  INTEGER NOT NULL,
        type         TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX idx_events_occurred_at ON events(occurred_at, id);
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE managed_worktrees (
        id          TEXT PRIMARY KEY,
        repo_root   TEXT NOT NULL,
        path        TEXT NOT NULL,
        branch      TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE(repo_root, path),
        UNIQUE(repo_root, branch)
      );

      CREATE INDEX idx_managed_worktrees_repo_root
        ON managed_worktrees(repo_root, created_at);
    `);
  },
  (database) => {
    database.exec(`
      CREATE TABLE orchestration_runs (
        id           TEXT PRIMARY KEY,
        objective    TEXT NOT NULL,
        repo_root    TEXT NOT NULL,
        base_branch  TEXT NOT NULL,
        status       TEXT NOT NULL,
        concurrency  INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        started_at   INTEGER,
        completed_at INTEGER,
        error        TEXT
      );

      CREATE TABLE orchestration_tasks (
        id            TEXT PRIMARY KEY,
        run_id        TEXT NOT NULL REFERENCES orchestration_runs(id) ON DELETE CASCADE,
        ordinal       INTEGER NOT NULL,
        title         TEXT NOT NULL,
        instructions  TEXT NOT NULL,
        provider      TEXT NOT NULL,
        status        TEXT NOT NULL,
        attempt       INTEGER NOT NULL,
        worktree_id   TEXT,
        worktree_path TEXT,
        branch        TEXT,
        terminal_id   TEXT,
        summary       TEXT,
        error         TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        started_at    INTEGER,
        completed_at  INTEGER,
        UNIQUE(run_id, ordinal)
      );

      CREATE INDEX idx_orchestration_runs_repo
        ON orchestration_runs(repo_root, created_at DESC);
      CREATE INDEX idx_orchestration_tasks_run
        ON orchestration_tasks(run_id, ordinal);
      CREATE INDEX idx_orchestration_tasks_terminal
        ON orchestration_tasks(terminal_id);
    `);
  },
  (database) => {
    database.exec(`
      ALTER TABLE orchestration_runs
        ADD COLUMN strategy TEXT NOT NULL DEFAULT 'balanced';
      ALTER TABLE orchestration_tasks
        ADD COLUMN role TEXT NOT NULL DEFAULT 'specialist';
      ALTER TABLE orchestration_tasks
        ADD COLUMN deliverable TEXT NOT NULL DEFAULT '';
    `);
  },
  (database) => {
    database.exec(`
      ALTER TABLE orchestration_runs
        ADD COLUMN integration_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE orchestration_runs
        ADD COLUMN integration_error TEXT;
      ALTER TABLE orchestration_runs
        ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE orchestration_runs
        ADD COLUMN verification_provider TEXT;
      ALTER TABLE orchestration_runs
        ADD COLUMN verification_terminal_id TEXT;
      ALTER TABLE orchestration_runs
        ADD COLUMN verification_summary TEXT;
      ALTER TABLE orchestration_runs
        ADD COLUMN verification_error TEXT;

      ALTER TABLE orchestration_tasks
        ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE orchestration_tasks
        ADD COLUMN integration_status TEXT NOT NULL DEFAULT 'pending';
      ALTER TABLE orchestration_tasks
        ADD COLUMN integration_commit TEXT;
      ALTER TABLE orchestration_tasks
        ADD COLUMN integration_error TEXT;
      ALTER TABLE orchestration_tasks
        ADD COLUMN reviewed_at INTEGER;
      ALTER TABLE orchestration_tasks
        ADD COLUMN integrated_at INTEGER;

      CREATE INDEX idx_orchestration_runs_verification_terminal
        ON orchestration_runs(verification_terminal_id);
    `);
  }
];

export class RelayDatabase {
  private database: Database.Database | null = null;

  constructor(readonly path: string) {}

  open(): void {
    if (this.database) return;

    const database = new Database(this.path);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    this.migrate(database);
    this.database = database;
  }

  close(): void {
    if (!this.database) return;
    this.database.close();
    this.database = null;
  }

  health(): DatabaseHealth {
    return {
      open: this.database !== null,
      path: this.path,
      schemaVersion: this.database
        ? Number(this.database.pragma('user_version', { simple: true }))
        : 0
    };
  }

  setValue(key: string, value: unknown): void {
    const database = this.requireOpen();
    database.prepare(`
      INSERT INTO app_kv (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  getValue<T>(key: string): T | undefined {
    const database = this.requireOpen();
    const row = database
      .prepare('SELECT value_json AS valueJson FROM app_kv WHERE key = ?')
      .get(key) as { valueJson: string } | undefined;

    if (!row) return undefined;
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return undefined;
    }
  }

  appendEvent(type: string, payload: unknown): number {
    const database = this.requireOpen();
    const result = database
      .prepare('INSERT INTO events (occurred_at, type, payload_json) VALUES (?, ?, ?)')
      .run(Date.now(), type, JSON.stringify(payload));
    return Number(result.lastInsertRowid);
  }

  listEvents(request: ActivityListRequest = {}): ActivityPage {
    const database = this.requireOpen();
    const limit = Math.max(1, Math.min(100, Math.round(request.limit ?? 30)));
    const category = activityCategory(request.category);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (request.beforeId !== undefined && Number.isFinite(request.beforeId)) {
      clauses.push('id < ?');
      parameters.push(Math.max(1, Math.round(request.beforeId)));
    }
    if (category !== 'all') {
      const prefix = category === 'system' ? 'app.%' : `${category}.%`;
      clauses.push('type LIKE ?');
      parameters.push(prefix);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = database.prepare(`
      SELECT id, occurred_at AS occurredAt, type, payload_json AS payloadJson
      FROM events ${where}
      ORDER BY id DESC
      LIMIT ?
    `).all(...parameters, limit + 1) as EventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(eventFromRow);
    return {
      events,
      hasMore,
      nextBeforeId: hasMore ? events.at(-1)?.id : undefined
    };
  }

  countEvents(): number {
    const row = this.requireOpen().prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number };
    return row.count;
  }

  listWorktrees(repoRoot?: string): WorktreeRecord[] {
    const database = this.requireOpen();
    const rows = (repoRoot
      ? database.prepare(`
          SELECT id, repo_root AS repoRoot, path, branch, base_branch AS baseBranch,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM managed_worktrees WHERE repo_root = ? ORDER BY created_at
        `).all(repoRoot)
      : database.prepare(`
          SELECT id, repo_root AS repoRoot, path, branch, base_branch AS baseBranch,
                 created_at AS createdAt, updated_at AS updatedAt
          FROM managed_worktrees ORDER BY created_at
        `).all()) as WorktreeRecord[];
    return rows;
  }

  getWorktree(id: string): WorktreeRecord | undefined {
    const database = this.requireOpen();
    return database.prepare(`
      SELECT id, repo_root AS repoRoot, path, branch, base_branch AS baseBranch,
             created_at AS createdAt, updated_at AS updatedAt
      FROM managed_worktrees WHERE id = ?
    `).get(id) as WorktreeRecord | undefined;
  }

  upsertWorktree(record: WorktreeRecord): void {
    const database = this.requireOpen();
    database.prepare(`
      INSERT INTO managed_worktrees
        (id, repo_root, path, branch, base_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        repo_root = excluded.repo_root,
        path = excluded.path,
        branch = excluded.branch,
        base_branch = excluded.base_branch,
        updated_at = excluded.updated_at
    `).run(
      record.id,
      record.repoRoot,
      record.path,
      record.branch,
      record.baseBranch,
      record.createdAt,
      record.updatedAt
    );
  }

  deleteWorktree(id: string): boolean {
    return this.requireOpen()
      .prepare('DELETE FROM managed_worktrees WHERE id = ?')
      .run(id).changes > 0;
  }

  createOrchestration(snapshot: OrchestrationSnapshot): void {
    const database = this.requireOpen();
    const insert = database.transaction(() => {
      this.writeRun(snapshot.run);
      for (const task of snapshot.tasks) this.writeTask(task);
    });
    insert();
  }

  listOrchestrations(repoRoot?: string): OrchestrationSnapshot[] {
    const database = this.requireOpen();
    const rows = (repoRoot
      ? database.prepare(`${RUN_SELECT} WHERE repo_root = ? ORDER BY created_at DESC LIMIT 50`).all(repoRoot)
      : database.prepare(`${RUN_SELECT} ORDER BY created_at DESC LIMIT 50`).all()) as RunRow[];
    return rows.map((row) => {
      const run = runFromRow(row);
      return { run, tasks: this.listOrchestrationTasks(run.id) };
    });
  }

  getOrchestration(id: string): OrchestrationSnapshot | undefined {
    const row = this.requireOpen().prepare(`${RUN_SELECT} WHERE id = ?`).get(id) as RunRow | undefined;
    if (!row) return undefined;
    const run = runFromRow(row);
    return { run, tasks: this.listOrchestrationTasks(run.id) };
  }

  getOrchestrationTask(id: string): OrchestrationTask | undefined {
    const row = this.requireOpen().prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getOrchestrationTaskByTerminal(terminalId: string): OrchestrationTask | undefined {
    const row = this.requireOpen()
      .prepare(`${TASK_SELECT} WHERE terminal_id = ?`)
      .get(terminalId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  getOrchestrationByVerificationTerminal(terminalId: string): OrchestrationSnapshot | undefined {
    const row = this.requireOpen()
      .prepare(`${RUN_SELECT} WHERE verification_terminal_id = ?`)
      .get(terminalId) as RunRow | undefined;
    if (!row) return undefined;
    const run = runFromRow(row);
    return { run, tasks: this.listOrchestrationTasks(run.id) };
  }

  listOrchestrationTasks(runId: string): OrchestrationTask[] {
    const rows = this.requireOpen()
      .prepare(`${TASK_SELECT} WHERE run_id = ? ORDER BY ordinal`)
      .all(runId) as TaskRow[];
    return rows.map(taskFromRow);
  }

  updateOrchestrationRun(run: OrchestrationRun): void {
    this.writeRun(run);
  }

  updateOrchestrationTask(task: OrchestrationTask): void {
    this.writeTask(task);
  }

  recoverInterruptedOrchestrations(): number {
    const database = this.requireOpen();
    const now = Date.now();
    const recover = database.transaction(() => {
      const tasks = database.prepare(`
        UPDATE orchestration_tasks
        SET status = 'blocked', updated_at = ?, completed_at = ?,
            error = 'Relay restarted before this task finished.'
        WHERE status IN ('queued', 'starting', 'running', 'stopping')
      `).run(now, now).changes;
      database.prepare(`
        UPDATE orchestration_runs
        SET status = 'blocked', updated_at = ?, completed_at = ?,
            error = 'Relay restarted before this run finished.'
        WHERE status IN ('queued', 'running', 'stopping')
      `).run(now, now);
      const integrations = database.prepare(`
        UPDATE orchestration_tasks
        SET integration_status = 'failed', integration_error = 'Relay restarted during integration.',
            updated_at = ?
        WHERE integration_status = 'integrating'
      `).run(now).changes;
      database.prepare(`
        UPDATE orchestration_runs
        SET integration_status = 'failed', integration_error = 'Relay restarted during integration.',
            updated_at = ?
        WHERE integration_status = 'integrating'
      `).run(now);
      const verifications = database.prepare(`
        UPDATE orchestration_runs
        SET verification_status = 'failed', verification_error = 'Relay restarted during verification.',
            updated_at = ?
        WHERE verification_status = 'running'
      `).run(now).changes;
      return tasks + integrations + verifications;
    });
    return recover();
  }

  private writeRun(run: OrchestrationRun): void {
    this.requireOpen().prepare(`
      INSERT INTO orchestration_runs
        (id, objective, repo_root, base_branch, status, strategy, concurrency, created_at,
         updated_at, started_at, completed_at, error, integration_status, integration_error,
         verification_status, verification_provider, verification_terminal_id,
         verification_summary, verification_error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        objective = excluded.objective,
        repo_root = excluded.repo_root,
        base_branch = excluded.base_branch,
        status = excluded.status,
        strategy = excluded.strategy,
        concurrency = excluded.concurrency,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        error = excluded.error,
        integration_status = excluded.integration_status,
        integration_error = excluded.integration_error,
        verification_status = excluded.verification_status,
        verification_provider = excluded.verification_provider,
        verification_terminal_id = excluded.verification_terminal_id,
        verification_summary = excluded.verification_summary,
        verification_error = excluded.verification_error
    `).run(
      run.id, run.objective, run.repoRoot, run.baseBranch, run.status, run.strategy, run.concurrency,
      run.createdAt, run.updatedAt, run.startedAt ?? null, run.completedAt ?? null, run.error ?? null,
      run.integrationStatus ?? 'pending', run.integrationError ?? null,
      run.verificationStatus ?? 'idle', run.verificationProvider ?? null,
      run.verificationTerminalId ?? null, run.verificationSummary ?? null, run.verificationError ?? null
    );
  }

  private writeTask(task: OrchestrationTask): void {
    this.requireOpen().prepare(`
      INSERT INTO orchestration_tasks
        (id, run_id, ordinal, title, instructions, role, deliverable, provider, status, attempt,
         worktree_id, worktree_path, branch, terminal_id, summary, error,
         created_at, updated_at, started_at, completed_at, review_status, integration_status,
         integration_commit, integration_error, reviewed_at, integrated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        instructions = excluded.instructions,
        role = excluded.role,
        deliverable = excluded.deliverable,
        provider = excluded.provider,
        status = excluded.status,
        attempt = excluded.attempt,
        worktree_id = excluded.worktree_id,
        worktree_path = excluded.worktree_path,
        branch = excluded.branch,
        terminal_id = excluded.terminal_id,
        summary = excluded.summary,
        error = excluded.error,
        updated_at = excluded.updated_at,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at
        ,review_status = excluded.review_status
        ,integration_status = excluded.integration_status
        ,integration_commit = excluded.integration_commit
        ,integration_error = excluded.integration_error
        ,reviewed_at = excluded.reviewed_at
        ,integrated_at = excluded.integrated_at
    `).run(
      task.id, task.runId, task.ordinal, task.title, task.instructions, task.role, task.deliverable, task.provider,
      task.status, task.attempt, task.worktreeId ?? null, task.worktreePath ?? null,
      task.branch ?? null, task.terminalId ?? null, task.summary ?? null, task.error ?? null,
      task.createdAt, task.updatedAt, task.startedAt ?? null, task.completedAt ?? null,
      task.reviewStatus ?? 'pending', task.integrationStatus ?? 'pending',
      task.integrationCommit ?? null, task.integrationError ?? null,
      task.reviewedAt ?? null, task.integratedAt ?? null
    );
  }

  private migrate(database: Database.Database): void {
    const currentVersion = Number(database.pragma('user_version', { simple: true }));

    for (let index = currentVersion; index < MIGRATIONS.length; index += 1) {
      const apply = database.transaction(() => {
        MIGRATIONS[index](database);
        database.pragma(`user_version = ${index + 1}`);
      });
      apply();
    }
  }

  private requireOpen(): Database.Database {
    if (!this.database) throw new Error('Relay database is not open');
    return this.database;
  }
}

interface EventRow {
  id: number;
  occurredAt: number;
  type: string;
  payloadJson: string;
}

function eventFromRow(row: EventRow): ActivityEvent {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payloadJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    payload = {};
  }
  return { id: row.id, occurredAt: row.occurredAt, type: row.type, payload };
}

function activityCategory(value: ActivityCategory | undefined): ActivityCategory {
  return ['orchestration', 'worktree', 'terminal', 'system'].includes(value ?? '')
    ? value as ActivityCategory
    : 'all';
}

const RUN_SELECT = `
  SELECT id, objective, repo_root AS repoRoot, base_branch AS baseBranch, status,
         strategy, concurrency, created_at AS createdAt, updated_at AS updatedAt,
         started_at AS startedAt, completed_at AS completedAt, error,
         integration_status AS integrationStatus, integration_error AS integrationError,
         verification_status AS verificationStatus, verification_provider AS verificationProvider,
         verification_terminal_id AS verificationTerminalId,
         verification_summary AS verificationSummary, verification_error AS verificationError
  FROM orchestration_runs
`;

const TASK_SELECT = `
  SELECT id, run_id AS runId, ordinal, title, instructions, role, deliverable, provider, status,
         attempt, worktree_id AS worktreeId, worktree_path AS worktreePath,
         branch, terminal_id AS terminalId, summary, error,
         created_at AS createdAt, updated_at AS updatedAt,
         started_at AS startedAt, completed_at AS completedAt,
         review_status AS reviewStatus, integration_status AS integrationStatus,
         integration_commit AS integrationCommit, integration_error AS integrationError,
         reviewed_at AS reviewedAt, integrated_at AS integratedAt
  FROM orchestration_tasks
`;

type RunRow = Omit<
  OrchestrationRun,
  | 'startedAt' | 'completedAt' | 'error' | 'integrationError'
  | 'verificationProvider' | 'verificationTerminalId' | 'verificationSummary' | 'verificationError'
> & {
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  integrationError: string | null;
  verificationProvider: OrchestrationRun['verificationProvider'] | null;
  verificationTerminalId: string | null;
  verificationSummary: string | null;
  verificationError: string | null;
};

type TaskRow = Omit<
  OrchestrationTask,
  | 'worktreeId' | 'worktreePath' | 'branch' | 'terminalId' | 'summary' | 'error'
  | 'startedAt' | 'completedAt' | 'integrationCommit' | 'integrationError'
  | 'reviewedAt' | 'integratedAt'
> & {
  worktreeId: string | null;
  worktreePath: string | null;
  branch: string | null;
  terminalId: string | null;
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  completedAt: number | null;
  integrationCommit: string | null;
  integrationError: string | null;
  reviewedAt: number | null;
  integratedAt: number | null;
};

function runFromRow(row: RunRow): OrchestrationRun {
  return {
    ...row,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    error: row.error ?? undefined,
    integrationError: row.integrationError ?? undefined,
    verificationProvider: row.verificationProvider ?? undefined,
    verificationTerminalId: row.verificationTerminalId ?? undefined,
    verificationSummary: row.verificationSummary ?? undefined,
    verificationError: row.verificationError ?? undefined
  };
}

function taskFromRow(row: TaskRow): OrchestrationTask {
  return {
    ...row,
    worktreeId: row.worktreeId ?? undefined,
    worktreePath: row.worktreePath ?? undefined,
    branch: row.branch ?? undefined,
    terminalId: row.terminalId ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined
    ,integrationCommit: row.integrationCommit ?? undefined
    ,integrationError: row.integrationError ?? undefined
    ,reviewedAt: row.reviewedAt ?? undefined
    ,integratedAt: row.integratedAt ?? undefined
  };
}
