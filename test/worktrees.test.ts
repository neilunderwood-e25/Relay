import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayDatabase } from '../src/main/database';
import { WorktreeManager } from '../src/main/worktrees';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): {
  root: string;
  repo: string;
  database: RelayDatabase;
  manager: WorktreeManager;
} {
  const root = mkdtempSync(join(tmpdir(), 'relay-worktree-test-'));
  temporaryDirectories.push(root);
  const repo = join(root, 'project');
  git(root, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'Relay Test');
  git(repo, 'config', 'user.email', 'relay@example.test');
  writeFileSync(join(repo, 'README.md'), '# Test\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'Initial commit');

  const database = new RelayDatabase(join(root, 'relay.db'));
  database.open();
  const manager = new WorktreeManager({
    database,
    logger: pino({ enabled: false }),
    storageRoot: join(root, 'worktrees')
  });
  return { root, repo, database, manager };
}

describe('WorktreeManager', () => {
  it('inspects repositories and discovers the main checkout', async () => {
    const { repo, database, manager } = fixture();
    const snapshot = await manager.inspect(repo);

    expect(snapshot).toMatchObject({
      isRepository: true,
      mainRoot: realpathSync(repo),
      currentBranch: 'main',
      branches: ['main']
    });
    expect(snapshot.worktrees).toHaveLength(1);
    expect(snapshot.worktrees[0]).toMatchObject({ isMain: true, managed: false, branch: 'main' });
    database.close();
  });

  it('creates and persists an isolated worktree', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'worker-one', baseBranch: 'main' });

    expect(created).toMatchObject({
      branch: 'relay/worker-one',
      baseBranch: 'main',
      managed: true,
      status: 'ready'
    });
    expect(created.path).toBe(join(realpathSync(repo), '.relay', 'worktrees', 'worker-one'));
    expect(existsSync(created.path)).toBe(true);
    expect(database.getWorktree(created.id)?.path).toBe(created.path);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.relay/worktrees/');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.vscode/settings.json');
    expect(JSON.parse(readFileSync(join(repo, '.vscode', 'settings.json'), 'utf8'))).toMatchObject({
      'git.detectWorktrees': true,
      'scm.alwaysShowRepositories': true
    });
    expect(JSON.parse(readFileSync(join(repo, '.relay', 'Relay.code-workspace'), 'utf8'))).toMatchObject({
      folders: [
        { name: 'Main · main', path: '..' },
        { name: 'relay/worker-one', path: 'worktrees/worker-one' }
      ]
    });

    const refreshed = await manager.inspect(repo);
    expect(refreshed.worktrees.some((worktree) => worktree.id === created.id)).toBe(true);
    database.close();
  });

  it('preserves existing VS Code settings while maintaining the Relay workspace', async () => {
    const { repo, database, manager } = fixture();
    mkdirSync(join(repo, '.vscode'));
    writeFileSync(join(repo, '.vscode', 'settings.json'), '{\n  "editor.fontSize": 15\n}\n');
    git(repo, 'add', '.vscode/settings.json');
    git(repo, 'commit', '-m', 'Add editor settings');

    await manager.create({ repoPath: repo, name: 'settings-safe' });

    expect(readFileSync(join(repo, '.vscode', 'settings.json'), 'utf8'))
      .toBe('{\n  "editor.fontSize": 15\n}\n');
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'))
      .not.toContain('/.vscode/settings.json');
    expect(existsSync(join(repo, '.relay', 'Relay.code-workspace'))).toBe(true);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    database.close();
  });

  it('refuses to remove a dirty worktree and removes it once clean', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'safe-remove' });
    writeFileSync(join(created.path, 'README.md'), '# Changed\n');

    await expect(manager.remove({ id: created.id })).resolves.toEqual({
      ok: false,
      error: 'Worktree has uncommitted changes.'
    });
    expect(existsSync(created.path)).toBe(true);

    git(created.path, 'reset', '--hard', 'HEAD');
    await expect(manager.remove({ id: created.id })).resolves.toEqual({ ok: true });
    expect(existsSync(created.path)).toBe(false);
    expect(database.getWorktree(created.id)).toBeUndefined();
    database.close();
  });

  it('refuses to discard commits that are ahead of the base branch', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'ahead-branch' });
    writeFileSync(join(created.path, 'agent.txt'), 'work\n');
    git(created.path, 'add', 'agent.txt');
    git(created.path, 'commit', '-m', 'Agent work');

    await expect(manager.remove({ id: created.id })).resolves.toEqual({
      ok: false,
      error: 'Worktree has unmerged commits.'
    });
    expect(existsSync(created.path)).toBe(true);
    database.close();
  });

  it('builds a review diff for tracked and untracked changes', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'review-diff' });
    writeFileSync(join(created.path, 'README.md'), '# Updated\n');
    writeFileSync(join(created.path, 'new-file.ts'), 'export const ready = true;\n');

    const diff = await manager.diff(created.id, 'task-review');

    expect(diff).toMatchObject({ taskId: 'task-review', branch: created.branch, truncated: false });
    expect(diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'README.md', status: 'modified' }),
      expect.objectContaining({ path: 'new-file.ts', status: 'added' })
    ]));
    expect(diff.patch).toContain('+export const ready = true;');
    database.close();
  });

  it('squashes and integrates task changes into the base branch', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'integrate-task' });
    writeFileSync(join(created.path, 'feature.ts'), 'export const feature = true;\n');
    const hookMarker = join(repo, 'hook-ran');
    const hook = join(repo, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, `#!/bin/sh\ntouch "${hookMarker}"\n`);
    chmodSync(hook, 0o755);

    const result = await manager.integrate(created.id, 'Relay: integrate task');

    expect(result.status).toBe('integrated');
    expect(existsSync(join(repo, 'feature.ts'))).toBe(true);
    expect(git(repo, 'log', '-1', '--pretty=%s')).toBe('Relay: integrate task');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(created.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(existsSync(hookMarker)).toBe(false);

    writeFileSync(join(created.path, 'feature.ts'), 'export const feature = "reconciled";\n');
    const followup = await manager.integrate(created.id, 'Relay: reconcile task');

    expect(followup.status).toBe('integrated');
    expect(readFileSync(join(repo, 'feature.ts'), 'utf8')).toContain('reconciled');
    expect(git(created.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'HEAD'));
    database.close();
  });

  it('aborts conflicts without leaving the project checkout conflicted', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'conflict-task' });
    writeFileSync(join(created.path, 'README.md'), '# Agent version\n');
    writeFileSync(join(repo, 'README.md'), '# Main version\n');
    git(repo, 'add', 'README.md');
    git(repo, 'commit', '-m', 'Move main forward');

    const result = await manager.integrate(created.id, 'Relay: conflicting task');

    expect(result).toMatchObject({ status: 'conflict', conflicts: ['README.md'] });
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Main version\n');
    database.close();
  });

  it('forgets a managed record when its worktree is already missing', async () => {
    const { repo, database, manager } = fixture();
    const created = await manager.create({ repoPath: repo, name: 'stale-worktree' });
    git(repo, 'worktree', 'remove', created.path);

    expect(existsSync(created.path)).toBe(false);
    await expect(manager.remove({ id: created.id })).resolves.toEqual({ ok: true });
    expect(database.getWorktree(created.id)).toBeUndefined();
    database.close();
  });

  it('returns a useful snapshot for non-repositories', async () => {
    const { root, database, manager } = fixture();
    const snapshot = await manager.inspect(root);

    expect(snapshot.isRepository).toBe(false);
    expect(snapshot.error).toBe('This folder is not a Git repository.');
    database.close();
  });

  it('rejects worktree names that could escape managed storage', async () => {
    const { repo, database, manager } = fixture();

    await expect(manager.create({ repoPath: repo, name: '../escape' }))
      .rejects.toThrow('Use 1–48 letters, numbers, dots, dashes, or underscores.');
    expect(database.listWorktrees()).toEqual([]);
    database.close();
  });

  it('rejects a symlinked managed worktree directory', async () => {
    const { root, repo, database, manager } = fixture();
    const outside = join(root, 'outside-worktrees');
    mkdirSync(outside);
    symlinkSync(outside, join(repo, '.relay'));

    await expect(manager.create({ repoPath: repo, name: 'escaped' }))
      .rejects.toThrow('resolves outside the project');
    expect(database.listWorktrees()).toEqual([]);
    database.close();
  });

  it('keeps legacy Harness Home worktrees removable after changing the layout', async () => {
    const { root, repo, database, manager } = fixture();
    const path = join(root, 'worktrees', 'legacy-agent');
    git(repo, 'worktree', 'add', '--no-track', '-b', 'relay/legacy-agent', path, 'main');
    const now = Date.now();
    database.upsertWorktree({
      id: 'worktree-legacy',
      repoRoot: realpathSync(repo),
      path,
      branch: 'relay/legacy-agent',
      baseBranch: 'main',
      createdAt: now,
      updatedAt: now
    });

    await expect(manager.remove({ id: 'worktree-legacy' })).resolves.toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    database.close();
  });

  it('removes Git-registered external worktrees while preserving their branches', async () => {
    const { root, repo, database, manager } = fixture();
    const path = join(root, 'external-worktree');
    git(repo, 'worktree', 'add', '--no-track', '-b', 'external/manual-check', path, 'main');
    const snapshot = await manager.inspect(repo);
    const external = snapshot.worktrees.find((worktree) => worktree.path === realpathSync(path));
    expect(external).toMatchObject({ managed: false, isMain: false });

    await expect(manager.remove({ id: external!.id, repoPath: repo })).resolves.toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    expect(git(repo, 'branch', '--list', 'external/manual-check')).toContain('external/manual-check');
    database.close();
  });

  it('requires force before deleting an external worktree with uncommitted changes', async () => {
    const { root, repo, database, manager } = fixture();
    const path = join(root, 'dirty-external');
    git(repo, 'worktree', 'add', '--no-track', '-b', 'external/dirty', path, 'main');
    writeFileSync(join(path, 'draft.txt'), 'unsaved\n');
    const external = (await manager.inspect(repo)).worktrees.find((worktree) => worktree.path === realpathSync(path))!;

    await expect(manager.remove({ id: external.id, repoPath: repo })).resolves.toEqual({
      ok: false,
      error: 'Worktree has uncommitted changes.'
    });
    expect(existsSync(path)).toBe(true);
    await expect(manager.remove({ id: external.id, repoPath: repo, force: true })).resolves.toEqual({ ok: true });
    expect(existsSync(path)).toBe(false);
    database.close();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
