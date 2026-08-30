import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type {
  OperationResult,
  IdeWorkspaceOpenResult,
  RepositorySnapshot,
  TaskDiffFile,
  TaskDiffSnapshot,
  WorktreeCreateRequest,
  WorktreeIntegrationResult,
  WorktreeRecord,
  WorktreeRemoveRequest,
  WorktreeSnapshot
} from '../shared/contracts';
import type { RelayDatabase } from './database';
import { resolveExecutable } from './providers';

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const GIT_TIMEOUT_MS = 20_000;
const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/;
const MAX_PATCH_OUTPUT = 512 * 1024;
const MAX_UNTRACKED_DIFFS = 100;
const IDE_WORKSPACE_NAME = 'Relay.code-workspace';
const RELAY_WORKTREE_SETTING = '/.vscode/settings.json';
const RELAY_WORKSPACE_EXCLUDE = `/.relay/${IDE_WORKSPACE_NAME}`;

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

  async prepareIdeWorkspace(directory: string): Promise<string> {
    const repository = await this.inspect(directory);
    if (!repository.isRepository || !repository.mainRoot) {
      throw new Error(repository.error ?? 'Choose a Git repository first.');
    }

    const repositoryRoot = await realpath(repository.mainRoot);
    const relayDirectory = resolve(repositoryRoot, '.relay');
    await mkdir(relayDirectory, { recursive: true });
    if (await realpath(relayDirectory) !== resolve(repositoryRoot, '.relay')) {
      throw new Error('Refusing an IDE workspace folder that resolves outside the project.');
    }

    const projectWorktrees = repository.worktrees.filter((worktree) =>
      !worktree.isMain
      && worktree.status !== 'missing'
      && isWithin(resolve(repositoryRoot, '.relay', 'worktrees'), resolve(worktree.path))
    );
    const folders = [
      { name: `Main · ${repository.currentBranch ?? 'detached'}`, path: '..' },
      ...projectWorktrees.map((worktree) => ({
        name: worktree.branch,
        path: relative(relayDirectory, worktree.path)
      }))
    ];
    const workspacePath = resolve(relayDirectory, IDE_WORKSPACE_NAME);
    await writeFile(workspacePath, `${JSON.stringify({
      folders,
      settings: ideWorktreeSettings()
    }, null, 2)}\n`, 'utf8');

    const settingsCreated = await this.ensureFolderWorktreeSettings(repositoryRoot);
    await this.ensureProjectLocalExcludes(repositoryRoot, [
      '/.relay/worktrees/',
      RELAY_WORKSPACE_EXCLUDE,
      ...(settingsCreated ? [RELAY_WORKTREE_SETTING] : [])
    ]);
    return workspacePath;
  }

  async openIdeWorkspace(directory: string): Promise<IdeWorkspaceOpenResult> {
    try {
      const workspacePath = await this.prepareIdeWorkspace(directory);
      const resolved = await resolveIde();
      if (!resolved) {
        return { ok: false, error: 'Install Cursor or Visual Studio Code, or add its CLI to PATH.' };
      }
      await launchDetached(resolved.executable, ['--new-window', workspacePath]);
      this.options.database.appendEvent('ide.workspace.opened', {
        ide: resolved.ide,
        workspacePath
      });
      return { ok: true, ide: resolved.ide, workspacePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async diff(worktreeId: string, taskId: string): Promise<TaskDiffSnapshot> {
    const record = this.requireManagedWorktree(worktreeId);
    const pathInfo = await stat(record.path).catch(() => null);
    if (!pathInfo?.isDirectory()) throw new Error('The task worktree is missing.');

    const mergeBase = await this.mergeBase(record);
    const [patchResult, numstatResult, statusResult, untrackedResult] = await Promise.all([
      runGit(record.path, ['diff', '--no-ext-diff', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', mergeBase, '--']),
      runGit(record.path, ['diff', '--numstat', '--find-renames', mergeBase, '--']),
      runGit(record.path, ['diff', '--name-status', '--find-renames', mergeBase, '--']),
      runGit(record.path, ['ls-files', '--others', '--exclude-standard', '-z'])
    ]);
    if (!patchResult.ok || !numstatResult.ok || !statusResult.ok || !untrackedResult.ok) {
      throw new Error(gitError([patchResult, numstatResult, statusResult, untrackedResult].find((result) => !result.ok)!));
    }

    const statusByPath = parseNameStatuses(statusResult.stdout);
    const tracked = parseNumstat(numstatResult.stdout, statusByPath);
    const allUntrackedPaths = untrackedResult.stdout.split('\0').filter(Boolean);
    const untrackedPaths = allUntrackedPaths.slice(0, MAX_UNTRACKED_DIFFS);
    const untracked = await Promise.all(untrackedPaths.map(async (path): Promise<{ file: TaskDiffFile; patch: string }> => {
      const result = await runGit(record.path, ['diff', '--no-index', '--', '/dev/null', path]);
      const additions = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
      return {
        file: { path, status: 'added', additions, deletions: 0 },
        patch: result.stdout
      };
    }));

    const files = [...tracked.files, ...untracked.map(({ file }) => file)];
    const fullPatch = [patchResult.stdout, ...untracked.map(({ patch }) => patch)].filter(Boolean).join('\n');
    return {
      taskId,
      branch: record.branch,
      baseBranch: record.baseBranch,
      files,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      patch: fullPatch.slice(0, MAX_PATCH_OUTPUT),
      truncated: fullPatch.length > MAX_PATCH_OUTPUT || allUntrackedPaths.length > MAX_UNTRACKED_DIFFS
    };
  }

  integrate(worktreeId: string, commitMessage: string): Promise<WorktreeIntegrationResult> {
    return this.serialize(() => this.integrateNow(worktreeId, commitMessage));
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

    const projectStorageRoot = this.projectStorageRoot(repository.mainRoot);
    await mkdir(projectStorageRoot, { recursive: true });
    const canonicalRepositoryRoot = await realpath(repository.mainRoot);
    const canonicalStorageRoot = await realpath(projectStorageRoot);
    if (canonicalStorageRoot !== resolve(canonicalRepositoryRoot, '.relay', 'worktrees')) {
      throw new Error('Refusing a managed worktree folder that resolves outside the project.');
    }
    const worktreePath = resolve(canonicalStorageRoot, slug);
    if (!isWithin(projectStorageRoot, worktreePath)) throw new Error('Worktree path escaped managed storage.');
    const existing = this.options.database.listWorktrees(repository.mainRoot);
    if (existing.some((record) => resolve(record.path) === worktreePath || record.branch === branch)) {
      throw new Error('A managed worktree already uses this name.');
    }

    const pathInfo = await stat(worktreePath).catch(() => null);
    if (pathInfo) throw new Error('The managed worktree path already exists.');
    const branchCheck = await runGit(repository.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (branchCheck.ok) throw new Error(`Branch ${branch} already exists.`);

    await this.ensureProjectWorktreeIgnore(repository.mainRoot);
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
    try {
      await this.prepareIdeWorkspace(repository.mainRoot);
    } catch (error) {
      this.options.logger.warn({ error }, 'Could not refresh the IDE workspace');
    }
    return snapshot;
  }

  private async removeNow(request: WorktreeRemoveRequest): Promise<OperationResult> {
    if (!request || typeof request.id !== 'string') return { ok: false, error: 'Invalid worktree id.' };
    const record = this.options.database.getWorktree(request.id);
    if (!record) return this.removeExternalNow(request);
    if (!this.isManagedStoragePath(record.path, record.repoRoot)) {
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

  private async removeExternalNow(request: WorktreeRemoveRequest): Promise<OperationResult> {
    if (typeof request.repoPath !== 'string' || !isAbsolute(request.repoPath)) {
      return { ok: false, error: 'The worktree is no longer registered with Relay.' };
    }
    const repository = await this.inspect(request.repoPath);
    if (!repository.isRepository || !repository.mainRoot) {
      return { ok: false, error: repository.error ?? 'Choose a Git repository first.' };
    }
    const worktree = repository.worktrees.find((candidate) => candidate.id === request.id);
    if (!worktree) return { ok: false, error: 'The worktree is no longer registered with Git.' };
    if (worktree.isMain) return { ok: false, error: 'The main checkout cannot be removed.' };
    if (worktree.status === 'locked') return { ok: false, error: 'Unlock the worktree before removing it.' };
    if (worktree.status === 'missing') {
      const pruneResult = await runGit(repository.mainRoot, ['worktree', 'prune']);
      if (!pruneResult.ok) return { ok: false, error: gitError(pruneResult) };
      this.options.database.appendEvent('worktree.external_forgotten', {
        path: worktree.path,
        branch: worktree.branch
      });
      return { ok: true };
    }
    if (worktree.dirty && !request.force) {
      return { ok: false, error: 'Worktree has uncommitted changes.' };
    }

    const args = ['worktree', 'remove', ...(request.force ? ['--force'] : []), worktree.path];
    const removeResult = await runGit(repository.mainRoot, args);
    if (!removeResult.ok) return { ok: false, error: gitError(removeResult) };
    await runGit(repository.mainRoot, ['worktree', 'prune']);
    this.options.database.appendEvent('worktree.external_removed', {
      path: worktree.path,
      branch: worktree.branch
    });
    this.options.logger.info({ path: worktree.path, branch: worktree.branch }, 'External worktree removed');
    return { ok: true };
  }

  private async integrateNow(worktreeId: string, commitMessage: string): Promise<WorktreeIntegrationResult> {
    const record = this.requireManagedWorktree(worktreeId);
    const pathInfo = await stat(record.path).catch(() => null);
    if (!pathInfo?.isDirectory()) throw new Error('The task worktree is missing.');

    const [mainBranch, mainStatus, sourceStatus, preHead] = await Promise.all([
      runGit(record.repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      runGit(record.repoRoot, ['status', '--porcelain', '--untracked-files=all']),
      runGit(record.path, ['status', '--porcelain', '--untracked-files=all']),
      runGit(record.repoRoot, ['rev-parse', 'HEAD'])
    ]);
    if (!mainBranch.ok || mainBranch.stdout.trim() !== record.baseBranch) {
      throw new Error(`Check out ${record.baseBranch} in the project before integrating.`);
    }
    if (!mainStatus.ok) throw new Error('Could not verify the project checkout.');
    if (mainStatus.stdout.trim()) throw new Error('The project checkout has uncommitted changes.');
    if (!sourceStatus.ok || !preHead.ok) throw new Error('Could not verify the task worktree.');

    const mergeBase = await this.mergeBase(record);
    if (sourceStatus.stdout.trim()) {
      const add = await runGit(record.path, ['add', '-A']);
      if (!add.ok) throw new Error(gitError(add));
      const commit = await runGit(record.path, [
        '-c', 'user.name=Relay Integration',
        '-c', 'user.email=relay@localhost',
        'commit', '--no-gpg-sign', '-m', commitMessage
      ]);
      if (!commit.ok) {
        await runGit(record.path, ['reset']);
        throw new Error(gitError(commit));
      }
    }

    const commitsResult = await runGit(record.path, ['rev-list', '--reverse', `${mergeBase}..${record.branch}`]);
    if (!commitsResult.ok) throw new Error(gitError(commitsResult));
    const commits = commitsResult.stdout.split(/\r?\n/).filter(Boolean);
    if (commits.length === 0) return { status: 'no_changes' };

    const cherryPick = await runGit(record.repoRoot, ['cherry-pick', '--no-commit', ...commits], 60_000);
    if (!cherryPick.ok) {
      const conflictsResult = await runGit(record.repoRoot, ['diff', '--name-only', '--diff-filter=U']);
      const conflicts = conflictsResult.stdout.split(/\r?\n/).filter(Boolean);
      await runGit(record.repoRoot, ['cherry-pick', '--abort']);
      await runGit(record.repoRoot, ['reset', '--merge', preHead.stdout.trim()]);
      return {
        status: 'conflict',
        conflicts,
        error: conflicts.length > 0 ? `Conflicts in ${conflicts.join(', ')}` : gitError(cherryPick)
      };
    }

    const commit = await runGit(record.repoRoot, [
      '-c', 'user.name=Relay Integration',
      '-c', 'user.email=relay@localhost',
      'commit', '--no-gpg-sign', '-m', commitMessage
    ]);
    if (!commit.ok) {
      await runGit(record.repoRoot, ['reset', '--merge', preHead.stdout.trim()]);
      throw new Error(gitError(commit));
    }
    const integratedHead = await runGit(record.repoRoot, ['rev-parse', 'HEAD']);
    if (!integratedHead.ok) throw new Error(gitError(integratedHead));
    this.options.database.appendEvent('worktree.integrated', {
      worktreeId,
      branch: record.branch,
      commit: integratedHead.stdout.trim()
    });
    return { status: 'integrated', commit: integratedHead.stdout.trim() };
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
      status: worktree.prunable ? 'missing' : worktree.locked ? 'locked' : dirty ? 'dirty' : 'ready'
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationTail.then(operation, operation);
    this.mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private requireManagedWorktree(id: string): WorktreeRecord {
    if (typeof id !== 'string') throw new Error('Invalid worktree id.');
    const record = this.options.database.getWorktree(id);
    if (!record) throw new Error('Managed worktree was not found.');
    if (!this.isManagedStoragePath(record.path, record.repoRoot)) {
      throw new Error('Refusing to access a path outside managed storage.');
    }
    return record;
  }

  private projectStorageRoot(repoRoot: string): string {
    return resolve(repoRoot, '.relay', 'worktrees');
  }

  private isManagedStoragePath(path: string, repoRoot: string): boolean {
    const candidate = canonicalExistingPath(path);
    return isWithin(canonicalExistingPath(this.projectStorageRoot(repoRoot)), candidate)
      || isWithin(canonicalExistingPath(this.storageRoot), candidate);
  }

  private async ensureProjectWorktreeIgnore(repoRoot: string): Promise<void> {
    await this.ensureProjectLocalExcludes(repoRoot, ['/.relay/worktrees/']);
  }

  private async ensureProjectLocalExcludes(repoRoot: string, patterns: string[]): Promise<void> {
    const result = await runGit(repoRoot, [
      'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'
    ]);
    if (!result.ok || !result.stdout.trim()) throw new Error('Could not locate the local Git exclude file.');
    const excludePath = resolve(result.stdout.trim());
    const current = await readFile(excludePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    const currentPatterns = new Set(current.split(/\r?\n/).map((line) => line.trim()));
    const missing = patterns.filter((pattern) => !currentPatterns.has(pattern));
    if (missing.length === 0) return;
    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    await appendFile(excludePath, `${prefix}# Relay IDE integration\n${missing.join('\n')}\n`, 'utf8');
  }

  private async ensureFolderWorktreeSettings(repoRoot: string): Promise<boolean> {
    const vscodeDirectory = resolve(repoRoot, '.vscode');
    const settingsPath = resolve(vscodeDirectory, 'settings.json');
    if (existsSync(settingsPath)) {
      const current = await readFile(settingsPath, 'utf8').catch(() => '');
      try {
        const parsed = JSON.parse(current) as Record<string, unknown>;
        const expected = ideWorktreeSettings();
        return Object.keys(parsed).length === Object.keys(expected).length
          && Object.entries(expected).every(([key, value]) => parsed[key] === value);
      } catch {
        return false;
      }
    }
    await mkdir(vscodeDirectory, { recursive: true });
    if (await realpath(vscodeDirectory) !== resolve(repoRoot, '.vscode')) return false;
    await writeFile(settingsPath, `${JSON.stringify(ideWorktreeSettings(), null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx'
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    return true;
  }

  private async mergeBase(record: WorktreeRecord): Promise<string> {
    const result = await runGit(record.path, ['merge-base', record.branch, record.baseBranch]);
    if (!result.ok || !result.stdout.trim()) throw new Error('Could not resolve the task base commit.');
    return result.stdout.trim();
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

function canonicalExistingPath(path: string): string {
  const candidate = resolve(path);
  return existsSync(candidate) ? realpathSync.native(candidate) : candidate;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function gitError(result: GitResult): string {
  return result.stderr.trim() || result.stdout.trim() || `Git exited with code ${result.code ?? 'unknown'}.`;
}

function parseNameStatuses(output: string): Map<string, TaskDiffFile['status']> {
  const statuses = new Map<string, TaskDiffFile['status']>();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [rawStatus, ...paths] = line.split('\t');
    const path = paths.at(-1);
    if (!path) continue;
    const code = rawStatus.charAt(0);
    statuses.set(path, code === 'A' ? 'added'
      : code === 'M' ? 'modified'
        : code === 'D' ? 'deleted'
          : code === 'R' ? 'renamed'
            : code === 'C' ? 'copied'
              : 'unknown');
  }
  return statuses;
}

function parseNumstat(output: string, statuses: Map<string, TaskDiffFile['status']>): {
  files: TaskDiffFile[];
} {
  const files = output.split(/\r?\n/).filter(Boolean).map((line): TaskDiffFile => {
    const [rawAdditions, rawDeletions, ...pathParts] = line.split('\t');
    const path = pathParts.at(-1) ?? '(unknown)';
    return {
      path,
      status: statuses.get(path) ?? 'modified',
      additions: Number.parseInt(rawAdditions, 10) || 0,
      deletions: Number.parseInt(rawDeletions, 10) || 0
    };
  });
  for (const [path, status] of statuses) {
    if (!files.some((file) => file.path === path)) files.push({ path, status, additions: 0, deletions: 0 });
  }
  return { files };
}

function ideWorktreeSettings(): Record<string, boolean | number | string> {
  return {
    'git.detectWorktrees': true,
    'git.detectWorktreesLimit': 50,
    'git.autoRepositoryDetection': true,
    'scm.alwaysShowRepositories': true,
    'scm.repositories.selectionMode': 'multiple'
  };
}

async function resolveIde(): Promise<{ ide: 'cursor' | 'vscode'; executable: string } | null> {
  const candidates: Array<{ ide: 'cursor' | 'vscode'; command: string }> = [
    { ide: 'cursor', command: 'cursor' },
    { ide: 'vscode', command: 'code' }
  ];
  if (process.platform === 'darwin') {
    candidates.push(
      { ide: 'cursor', command: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' },
      { ide: 'vscode', command: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code' }
    );
  }
  for (const candidate of candidates) {
    const executable = await resolveExecutable(candidate.command);
    if (executable) return { ide: candidate.ide, executable };
  }
  return null;
}

function launchDetached(executable: string, args: string[]): Promise<void> {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(executable, args, {
      detached: true,
      shell: false,
      stdio: 'ignore'
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolveLaunch();
    });
  });
}

function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      shell: false,
      env: gitEnvironment(),
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

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK']) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}
