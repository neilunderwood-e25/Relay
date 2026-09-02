import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderId } from '../src/shared/contracts';
import { providerAdapter } from '../src/main/providerAdapters';
import { resolveProviderExecutable } from '../src/main/providers';
import { extractProviderResult } from '../src/shared/providerOutput';

const runReal = process.env.RELAY_REAL_CLI === '1' ? describe : describe.skip;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

runReal('real CLI release smoke', () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    const test = provider === 'cursor' && process.env.RELAY_REAL_CURSOR !== '1' ? it.skip : it;
    test(`${provider} plans read-only and edits an isolated worktree`, async () => {
      const executable = await resolveProviderExecutable(provider);
      expect(executable, `${provider} must be installed for the release smoke`).toBeTruthy();
      const fixture = createWorktreeFixture(provider);
      const token = `RELAY_${provider.toUpperCase()}_READY`;

      const planning = await runCli(
        executable!,
        providerAdapter(provider).planningArgs(
          `Reply with exactly ${token}. Do not modify files or Git state.`
        ),
        fixture.worktree
      );
      expect(planning.code, planning.output).toBe(0);
      expect(stripAnsi(planning.output)).toContain(token);
      expect(extractProviderResult(provider, planning.output)).toContain(token);
      expect(git(fixture.worktree, ['status', '--porcelain'])).toBe('');

      const filename = `relay-${provider}-smoke.txt`;
      const content = `RELAY_${provider.toUpperCase()}_WORKTREE_SMOKE`;
      const worker = await runCli(
        executable!,
        providerAdapter(provider).workerArgs(
          `Create ${filename} in the current directory with exactly this one line: ${content}. Do not commit. Then report completion.`
        ),
        fixture.worktree
      );
      expect(worker.code, worker.output).toBe(0);
      expect(readFileSync(join(fixture.worktree, filename), 'utf8').trim()).toBe(content);
      expect(git(fixture.root, ['status', '--porcelain'])).toBe('');
      expect(git(fixture.worktree, ['branch', '--show-current'])).toBe(`relay/smoke-${provider}`);
    }, 360_000);
  }
});

function createWorktreeFixture(provider: ProviderId): { root: string; worktree: string } {
  const container = mkdtempSync(join(tmpdir(), `relay-real-${provider}-`));
  temporaryDirectories.push(container);
  const root = join(container, 'project');
  const worktree = join(container, 'worktree');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Relay Smoke'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'relay-smoke@localhost'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-b', `relay/smoke-${provider}`, worktree, 'main'], { stdio: 'ignore' });
  return { root, worktree };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function runCli(executable: string, args: string[], cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (output.length < 2 * 1024 * 1024) output = (output + chunk.toString()).slice(0, 2 * 1024 * 1024);
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid!, 'SIGKILL');
      } catch { /* Process already exited. */ }
      reject(new Error(`Real CLI smoke timed out.\n${output.slice(-4_000)}`));
    }, 300_000);
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', finish);
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '');
}
