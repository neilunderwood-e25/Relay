import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type {
  OperationResult,
  RepositorySnapshot,
  WorktreeCreateRequest,
  WorktreeRecord,
  WorktreeRemoveRequest,
  WorktreeSnapshot
} from '../shared/contracts';
import type { RelayDatabase } from './database';

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;

interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface PorcelainWorktree {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeManagerOptions {
  database: RelayDatabase;
  logger: Logger;
  storageRoot: string;
}

export class WorktreeManager {
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly storageRoot: string;

  constructor(private readonly options: WorktreeManagerOptions) {
    this.storageRoot = resolve(options.storageRoot);
  }

  async inspect(directory: string): Promise<RepositorySnapshot> {
    const fallback = emptyRepository(directory);
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      return { ...fallback, error: 'Choose an absolute project path.' };
    }

    const directoryInfo = await stat(directory).catch(() => null);
    if (!directoryInfo?.isDirectory()) {
      return { ...fallback, error: 'Project directory was not found.' };
    }

    const rootResult = await runGit(directory, ['rev-parse', '--show-toplevel']);
    if (!rootResult.ok) {
      return { ...fallback, error: 'This folder is not a Git repository.' };
    }

    const root = resolve(rootResult.stdout.trim());
    const commonResult = await runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!commonResult.ok) return { ...fallback, error: gitError(commonResult) };
    const commonDirectory = resolve(commonResult.stdout.trim());
    const mainRoot = basename(commonDirectory) === '.git' ? dirname(commonDirectory) : root;

    const [branchResult, branchesResult, worktreesResult] = await Promise.all([
      runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(mainRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      runGit(mainRoot, ['worktree', 'list', '--porcelain'])
    ]);

    if (!branchesResult.ok || !worktreesResult.ok) {
      return { ...fallback, error: gitError(!branchesResult.ok ? branchesResult : worktreesResult) };
    }

    const currentBranch = branchResult.ok ? branchResult.stdout.trim() || null : null;
    const branches = branchesResult.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const registered = this.options.database.listWorktrees(mainRoot);
    const registeredByPath = new Map(registered.map((record) => [resolve(record.path), record]));
    const discovered = parseWorktrees(worktreesResult.stdout);
    const snapshots = await Promise.all(discovered.map((worktree) =>
      this.snapshotWorktree(worktree, mainRoot, registeredByPath.get(resolve(worktree.path)))
    ));

    const discoveredPaths = new Set(discovered.map((worktree) => resolve(worktree.path)));
    for (const record of registered) {
      if (!discoveredPaths.has(resolve(record.path))) snapshots.push(missingSnapshot(record));
    }

    snapshots.sort((left, right) => {
      if (left.isMain !== right.isMain) return left.isMain ? -1 : 1;
      if (left.managed !== right.managed) return left.managed ? -1 : 1;
      return left.createdAt - right.createdAt || left.path.localeCompare(right.path);
    });

    return {
      directory,
      isRepository: true,
      root,
      mainRoot,
      name: basename(mainRoot),
      currentBranch,
      branches,
      worktrees: snapshots
    };
  }

  create(request: WorktreeCreateRequest): Promise<WorktreeSnapshot> {
    return this.serialize(() => this.createNow(request));
  }

  remove(request: WorktreeRemoveRequest): Promise<OperationResult> {
    return this.serialize(() => this.removeNow(request));
  }

  private async createNow(request: WorktreeCreateRequest): Promise<WorktreeSnapshot> {
    if (!request || typeof request.repoPath !== 'string' || typeof request.name !== 'string') {
      throw new Error('Invalid worktree request.');
    }
    const name = request.name.trim();
    if (!WORKTREE_NAME.test(name)) {
      throw new Error('Use 1–48 letters, numbers, dots, dashes, or underscores.');
    }

    const repository = await this.inspect(request.repoPath);
    if (!repository.isRepository || !repository.mainRoot) {
      throw new Error(repository.error ?? 'Choose a Git repository first.');
    }

    const slug = name.toLowerCase();
    const branch = `relay/${slug}`;
    const baseBranch = request.baseBranch?.trim() || repository.currentBranch || 'HEAD';
    if (!isSafeRef(baseBranch) || (!repository.branches.includes(baseBranch) && baseBranch !== 'HEAD')) {
      throw new Error('Choose a valid local base branch.');
    }

    const repoDirectory = `${basename(repository.mainRoot)}-${shortHash(repository.mainRoot)}`;
    const worktreePath = resolve(this.storageRoot, repoDirectory, slug);
    if (!isWithin(this.storageRoot, worktreePath)) throw new Error('Worktree path escaped managed storage.');
    const existing = this.options.database.listWorktrees(repository.mainRoot);
    if (existing.some((record) => resolve(record.path) === worktreePath || record.branch === branch)) {
      throw new Error('A managed worktree already uses this name.');
    }

    const pathInfo = await stat(worktreePath).catch(() => null);
    if (pathInfo) throw new Error('The managed worktree path already exists.');
    const branchCheck = await runGit(repository.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (branchCheck.ok) throw new Error(`Branch ${branch} already exists.`);

    await mkdir(dirname(worktreePath), { recursive: true });
    const addResult = await runGit(repository.mainRoot, [
      'worktree', 'add', '--no-track', '-b', branch, worktreePath, baseBranch
    ]);
    if (!addResult.ok) throw new Error(gitError(addResult));

    const now = Date.now();
    const record: WorktreeRecord = {
      id: `worktree-${randomUUID().slice(0, 12)}`,
      repoRoot: repository.mainRoot,
      path: worktreePath,
      branch,
      baseBranch,
      createdAt: now,
      updatedAt: now
    };

    try {
      this.options.database.upsertWorktree(record);
      this.options.database.appendEvent('worktree.created', record);
    } catch (error) {
      await runGit(repository.mainRoot, ['worktree', 'remove', '--force', worktreePath]);
      throw error;
    }

    const headResult = await runGit(worktreePath, ['rev-parse', 'HEAD']);
    const snapshot: WorktreeSnapshot = {
      ...record,
      head: headResult.ok ? headResult.stdout.trim() : '',
      managed: true,
      isMain: false,
      dirty: false,
      ahead: 0,
      status: 'ready'
    };
    this.options.logger.info({ worktreeId: record.id, branch, path: worktreePath }, 'Worktree created');
    return snapshot;
  }

  private async removeNow(request: WorktreeRemoveRequest): Promise<OperationResult> {
    if (!request || typeof request.id !== 'string') return { ok: false, error: 'Invalid worktree id.' };
    const record = this.options.database.getWorktree(request.id);
    if (!record) return { ok: false, error: 'Managed worktree was not found.' };
    if (!isWithin(this.storageRoot, resolve(record.path))) {
      return { ok: false, error: 'Refusing to remove a path outside managed storage.' };
    }

    const pathInfo = await stat(record.path).catch(() => null);
    if (!pathInfo) {
      await runGit(record.repoRoot, ['worktree', 'prune']);
      this.options.database.deleteWorktree(record.id);
      this.options.database.appendEvent('worktree.forgotten', record);
      return { ok: true };
    }

    if (pathInfo && !pathInfo.isDirectory()) return { ok: false, error: 'Managed worktree path is not a directory.' };
    if (!request.force) {
      const statusResult = await runGit(record.path, ['status', '--porcelain', '--untracked-files=all']);
      if (!statusResult.ok) return { ok: false, error: 'Could not verify worktree safety.' };
      if (statusResult.stdout.trim()) return { ok: false, error: 'Worktree has uncommitted changes.' };
      const aheadResult = await runGit(record.path, ['rev-list', '--count', `${record.baseBranch}..HEAD`]);
      if (!aheadResult.ok) return { ok: false, error: 'Could not verify branch integration.' };
      if ((Number.parseInt(aheadResult.stdout.trim(), 10) || 0) > 0) {
        return { ok: false, error: 'Worktree has unmerged commits.' };
      }
    }

    const args = ['worktree', 'remove', ...(request.force ? ['--force'] : []), record.path];
    const removeResult = await runGit(record.repoRoot, args);
    if (!removeResult.ok) return { ok: false, error: gitError(removeResult) };
    await runGit(record.repoRoot, ['worktree', 'prune']);
    this.options.database.deleteWorktree(record.id);
    this.options.database.appendEvent('worktree.removed', record);
    this.options.logger.info({ worktreeId: record.id, path: record.path }, 'Worktree removed');
    return { ok: true };
  }

  private async snapshotWorktree(
    worktree: PorcelainWorktree,
    mainRoot: string,
    record?: WorktreeRecord
  ): Promise<WorktreeSnapshot> {
    const worktreePath = resolve(worktree.path);
    const statusResult = worktree.prunable
      ? null
      : await runGit(worktreePath, ['status', '--porcelain', '--untracked-files=all']);
    const dirty = statusResult ? (!statusResult.ok || statusResult.stdout.trim().length > 0) : false;
    let ahead = 0;
    if (record && !worktree.prunable) {
      const aheadResult = await runGit(worktreePath, ['rev-list', '--count', `${record.baseBranch}..HEAD`]);
      ahead = aheadResult.ok ? Number.parseInt(aheadResult.stdout.trim(), 10) || 0 : 1;
    }
    const now = Date.now();
    return {
      id: record?.id ?? `git-${shortHash(worktreePath)}`,
      repoRoot: mainRoot,
      path: worktreePath,
      branch: record?.branch ?? worktree.branch ?? '(detached)',
      baseBranch: record?.baseBranch ?? '',
      createdAt: record?.createdAt ?? 0,
      updatedAt: record?.updatedAt ?? now,
      head: worktree.head,
      managed: Boolean(record),
      isMain: worktreePath === resolve(mainRoot),
      dirty,
      ahead,
      status: worktree.locked ? 'locked' : dirty ? 'dirty' : 'ready'
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function emptyRepository(directory: string): RepositorySnapshot {
  return {
    directory,
    isRepository: false,
    root: null,
    mainRoot: null,
    name: basename(directory) || 'Project',
    currentBranch: null,
    branches: [],
    worktrees: []
  };
}

function missingSnapshot(record: WorktreeRecord): WorktreeSnapshot {
  return {
    ...record,
    head: '',
    managed: true,
    isMain: false,
    dirty: false,
    ahead: 0,
    status: 'missing'
  };
}

function parseWorktrees(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: Partial<PorcelainWorktree> | null = null;
  const flush = (): void => {
    if (current?.path) {
      worktrees.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? null,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false
      });
    }
    current = null;
  };
  for (const line of output.split(/\r?\n/)) {
    if (!line) { flush(); continue; }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice(9) };
    } else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (current && line.startsWith('locked')) current.locked = true;
    else if (current && line.startsWith('prunable')) current.prunable = true;
  }
  flush();
  return worktrees;
}

function isSafeRef(ref: string): boolean {
  return ref === 'HEAD' || (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref)
    && !ref.includes('..')
    && !ref.includes('//')
    && !ref.includes('@{')
    && !ref.endsWith('.')
    && !ref.endsWith('/')
    && !ref.endsWith('.lock')
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function gitError(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `Git exited with code ${result.code ?? 'unknown'}.`;
}

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_GIT_OUTPUT ? current : (current + chunk.toString()).slice(0, MAX_GIT_OUTPUT);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* Process already exited. */ }
      finish({ ok: false, code: null, stdout, stderr: `Git timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
  });
}
