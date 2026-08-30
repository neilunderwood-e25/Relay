import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateWorkspaceRequest } from '../src/main/workspaceValidation';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('workspace onboarding validation', () => {
  it('canonicalizes a writable home and Git project on a local branch', () => {
    const root = fixture();
    const project = repository(join(root, 'project'));
    const home = join(root, 'relay-home');
    const result = validateWorkspaceRequest({
      harnessHome: home,
      projectPath: project,
      orchestratorProvider: 'codex',
      orchestratorModel: 'gpt-5.6-sol'
    }, 'Avery');

    expect(result).toMatchObject({
      onboardingComplete: true,
      harnessHome: realpathSync(home),
      projectPath: realpathSync(project),
      orchestratorName: 'Avery',
      orchestratorProvider: 'codex'
    });
  });

  it('rejects non-Git projects and detached checkouts', () => {
    const root = fixture();
    const plain = join(root, 'plain');
    mkdirSync(plain);
    expect(() => validateWorkspaceRequest(request(join(root, 'home-1'), plain))).toThrow('Git repository');

    const project = repository(join(root, 'project'));
    execFileSync('git', ['-C', project, 'checkout', '--detach'], { stdio: 'ignore' });
    expect(() => validateWorkspaceRequest(request(join(root, 'home-2'), project))).toThrow('local branch');
  });

  it('rejects either direction of project and Harness Home overlap', () => {
    const first = fixture();
    const project = repository(join(first, 'project'));
    expect(() => validateWorkspaceRequest(request(join(project, '.relay'), project))).toThrow('separate folders');

    const second = fixture();
    const home = join(second, 'home');
    mkdirSync(home);
    const nestedProject = repository(join(home, 'project'));
    expect(() => validateWorkspaceRequest(request(home, nestedProject))).toThrow('separate folders');
  });

  it('canonicalizes a linked worktree to the repository main checkout', () => {
    const root = fixture();
    const project = repository(join(root, 'project'));
    const linked = join(root, 'linked');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-b', 'linked-branch', linked], { stdio: 'ignore' });

    const result = validateWorkspaceRequest(request(join(root, 'home'), linked));

    expect(result.projectPath).toBe(realpathSync(project));
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'relay-workspace-validation-'));
  temporaryDirectories.push(root);
  return root;
}

function repository(path: string): string {
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Relay Test'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'relay-test@localhost'], { stdio: 'ignore' });
  execFileSync('git', ['-C', path, 'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
  return path;
}

function request(harnessHome: string, projectPath: string) {
  return { harnessHome, projectPath, orchestratorProvider: 'claude' as const, orchestratorModel: null };
}
