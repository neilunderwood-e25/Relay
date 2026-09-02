import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareWorkerTerminal } from '../src/main/orchestratorBootstrap';
import { providerAdapter } from '../src/main/providerAdapters';
import { createNativeWorkerSessionId, resolveNativeWorkerSessionId } from '../src/main/providerSessions';
import { PtyManager } from '../src/main/pty';
import type { ProviderId } from '../src/shared/contracts';

const runReal = process.env.RELAY_REAL_CLI === '1' ? describe : describe.skip;
const temporaryDirectories: string[] = [];
const managers: PtyManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.stopAll();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

runReal('real interactive CLI smoke', () => {
  for (const provider of ['claude', 'codex', 'cursor'] as const) {
    const test = provider === 'cursor' && process.env.RELAY_REAL_CURSOR !== '1' ? it.skip : it;
    test(`${provider} accepts follow-ups and resumes its worktree conversation`, async () => {
      const worktree = createWorktreeFixture(provider);
      let output = '';
      const manager = new PtyManager({
        logger: pino({ enabled: false }),
        onData: (event) => { output = (output + event.data).slice(-1024 * 1024); }
      });
      managers.push(manager);
      const assignedNativeSessionId = provider === 'claude'
        ? randomUUID()
        : provider === 'cursor'
          ? await createNativeWorkerSessionId(provider, worktree)
          : undefined;
      const continuityPhrase = `relay-memory-${provider}-${randomUUID().slice(0, 8)}`;
      const spawned = await manager.spawn({
        provider,
        role: 'worker',
        name: `${provider} smoke`,
        cwd: worktree,
        cols: 120,
        rows: 32,
        outputMode: 'terminal',
        args: providerAdapter(provider).interactiveWorkerArgs(undefined, assignedNativeSessionId)
      });
      const prepared = await prepareWorkerTerminal(spawned, worktree, manager);
      expect(prepared.acceptedWorkspaceTrust, stripTerminalControl(output).slice(-5_000)).toBe(provider !== 'cursor');
      const token = `RELAY_INTERACTIVE_READY_${provider.toUpperCase()}`;
      const prompt = `Remember the exact continuity phrase ${continuityPhrase} for a later turn. ` +
        `Do not modify files or Git state. Reply briefly, then print a marker made by joining ` +
        `RELAY_INTERACTIVE_ and READY_${provider.toUpperCase()} with no spaces. Keep the CLI open afterward.`;
      expect(prompt).not.toContain(token);
      const submitted = await manager.submit(
        prepared.terminal.id,
        prompt
      );
      expect(submitted).toEqual({ ok: true });
      await eventually(() => stripTerminalControl(output).includes(token), 300_000);
      expect(manager.list().find(({ id }) => id === prepared.terminal.id)?.status).toBe('running');

      const followupToken = `RELAY_FOLLOWUP_READY_${provider.toUpperCase()}`;
      const followup = `This is a second turn. Do not modify files. Reply briefly, then print a marker made by joining ` +
        `RELAY_FOLLOWUP_ and READY_${provider.toUpperCase()} with no spaces. Keep the CLI open afterward.`;
      expect(followup).not.toContain(followupToken);
      await expect(manager.submit(prepared.terminal.id, followup)).resolves.toEqual({ ok: true });
      await eventually(() => stripTerminalControl(output).includes(followupToken), 300_000);
      expect(manager.list().find(({ id }) => id === prepared.terminal.id)?.status).toBe('running');

      const nativeSessionId = assignedNativeSessionId ?? await resolveNativeWorkerSessionId(
        provider,
        worktree,
        spawned.createdAt
      );
      expect(nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);

      expect(manager.stop(prepared.terminal.id)).toEqual({ ok: true });
      await eventually(
        () => manager.list().find(({ id }) => id === prepared.terminal.id)?.status === 'exited',
        15_000
      );
      output = '';
      const resumed = await manager.spawn({
        provider,
        role: 'worker',
        name: `${provider} resumed`,
        cwd: worktree,
        cols: 120,
        rows: 32,
        outputMode: 'terminal',
        args: providerAdapter(provider).resumeWorkerArgs(undefined, nativeSessionId)
      });
      const resumedReady = await prepareWorkerTerminal(resumed, worktree, manager);
      output = '';
      const resumeToken = `RELAY_RESUME_READY_${provider.toUpperCase()}`;
      const resumePrompt = `Reply with the exact continuity phrase I asked you to remember in the first turn. ` +
        `Do not modify files. Print a marker made by joining ` +
        `RELAY_RESUME_ and READY_${provider.toUpperCase()} with no spaces, then remain open.`;
      expect(resumePrompt).not.toContain(resumeToken);
      await expect(manager.submit(resumedReady.terminal.id, resumePrompt)).resolves.toEqual({ ok: true });
      await eventually(() => stripTerminalControl(output).includes(resumeToken), 300_000);
      expect(stripTerminalControl(output)).toContain(continuityPhrase);
      expect(manager.list().find(({ id }) => id === resumedReady.terminal.id)?.status).toBe('running');
      expect(git(worktree, ['status', '--porcelain'])).toBe('');
    }, 360_000);
  }
});

function createWorktreeFixture(provider: ProviderId): string {
  const container = mkdtempSync(join(tmpdir(), `relay-real-interactive-${provider}-`));
  temporaryDirectories.push(container);
  const root = join(container, 'project');
  const worktree = join(container, 'worktree');
  execFileSync('git', ['init', '-b', 'main', root], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Relay Smoke'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'config', 'user.email', 'relay-smoke@localhost'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-m', 'Initial'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-b', `relay/interactive-${provider}`, worktree, 'main'], { stdio: 'ignore' });
  return worktree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, '');
}

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Interactive CLI did not return the completion token in time.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
