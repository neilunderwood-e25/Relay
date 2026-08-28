import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(existsSync(created.path)).toBe(true);
    expect(database.getWorktree(created.id)?.path).toBe(created.path);

    const refreshed = await manager.inspect(repo);
    expect(refreshed.worktrees.some((worktree) => worktree.id === created.id)).toBe(true);
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
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
