import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNativeWorkerSessionId } from '../src/main/providerSessions';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('provider session identity', () => {
  it('finds the exact Codex thread for a worktree and ignores nearby sessions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-provider-sessions-'));
    roots.push(root);
    const codexHome = join(root, 'codex');
    const worktree = join(root, 'worktree');
    const other = join(root, 'other');
    mkdirSync(worktree);
    mkdirSync(other);
    const startedAt = Date.now();
    const date = new Date(startedAt);
    const sessionDirectory = join(
      codexHome,
      'sessions',
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    );
    mkdirSync(sessionDirectory, { recursive: true });
    writeSession(sessionDirectory, '01a057e7-ce82-7031-9fc4-cf3ec5800001', other);
    writeSession(sessionDirectory, '01a057e7-ce82-7031-9fc4-cf3ec5800002', worktree);

    await expect(resolveNativeWorkerSessionId('codex', worktree, startedAt, {
      codexHome,
      timeoutMs: 0
    })).resolves.toBe('01a057e7-ce82-7031-9fc4-cf3ec5800002');
  });

  it('returns no inferred identity for Claude or an unknown Codex worktree', async () => {
    await expect(resolveNativeWorkerSessionId('claude', '/tmp/worktree', Date.now(), { timeoutMs: 0 }))
      .resolves.toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), 'relay-provider-sessions-empty-'));
    roots.push(root);
    await expect(resolveNativeWorkerSessionId('codex', root, Date.now(), {
      codexHome: join(root, 'codex'),
      timeoutMs: 0
    })).resolves.toBeUndefined();
  });
});

function writeSession(directory: string, id: string, cwd: string): void {
  writeFileSync(join(directory, `rollout-${id}.jsonl`), `${JSON.stringify({
    type: 'session_meta',
    payload: { session_id: id, id, cwd }
  })}\n`);
}
