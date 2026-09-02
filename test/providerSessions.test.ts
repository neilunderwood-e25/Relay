import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createNativeWorkerSessionId,
  readNativeWorkerResult,
  resolveNativeWorkerSessionId
} from '../src/main/providerSessions';

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

  it('finds the newest Cursor chat transcript for the exact worktree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cursor-sessions-'));
    roots.push(root);
    const worktree = join(root, 'relay project', '.relay', 'worktrees', 'cursor-task');
    mkdirSync(worktree, { recursive: true });
    const cursorHome = join(root, 'cursor-home');
    const slug = realpathSync(worktree).replace(/^[/\\]+/, '').replace(/[^A-Za-z0-9_-]/g, '-');
    const transcripts = join(cursorHome, 'projects', slug, 'agent-transcripts');
    const older = '01a057e7-ce82-7031-9fc4-cf3ec5800003';
    const newest = '01a057e7-ce82-7031-9fc4-cf3ec5800004';
    writeCursorTranscript(transcripts, older, Date.now() - 2_000);
    writeCursorTranscript(transcripts, newest, Date.now());

    await expect(resolveNativeWorkerSessionId('cursor', worktree, Date.now() - 5_000, {
      cursorHome,
      timeoutMs: 0
    })).resolves.toBe(newest);
  });

  it.skipIf(process.platform === 'win32')('pre-allocates a Cursor chat identity before launch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cursor-create-chat-'));
    roots.push(root);
    const executable = join(root, 'agent');
    const nativeId = '01a057e7-ce82-7031-9fc4-cf3ec5800006';
    writeFileSync(executable, `#!/bin/sh\n[ "$1" = "create-chat" ] && echo "${nativeId}"\n`, 'utf8');
    chmodSync(executable, 0o755);

    await expect(createNativeWorkerSessionId('cursor', root, { env: { PATH: root } }))
      .resolves.toBe(nativeId);
    await expect(createNativeWorkerSessionId('claude', root)).resolves.toBeUndefined();
  });

  it('reads the final Claude assistant turn without terminal UI noise', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-claude-result-'));
    roots.push(root);
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const id = '01a057e7-ce82-7031-9fc4-cf3ec5800007';
    const slug = realpathSync(worktree).replace(/[^A-Za-z0-9_-]/g, '-');
    const directory = join(root, 'claude', 'projects', slug);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${id}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'old question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } },
      { type: 'user', message: { role: 'user', content: 'current question' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Clean Claude result\nRELAY_TASK_COMPLETE:abc' }] } }
    ].map((value) => JSON.stringify(value)).join('\n'));

    await expect(readNativeWorkerResult('claude', worktree, id, Date.now(), {
      claudeHome: join(root, 'claude'),
      requiredMarker: 'RELAY_TASK_COMPLETE:abc',
      timeoutMs: 0
    })).resolves.toBe('Clean Claude result\nRELAY_TASK_COMPLETE:abc');
  });

  it('reads the final Codex AgentMessage from its rollout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-codex-result-'));
    roots.push(root);
    const codexHome = join(root, 'codex');
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const startedAt = Date.now();
    const date = new Date(startedAt);
    const directory = join(codexHome, 'sessions', String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    mkdirSync(directory, { recursive: true });
    const id = '01a057e7-ce82-7031-9fc4-cf3ec5800008';
    writeFileSync(join(directory, `rollout-${id}.jsonl`), [
      { type: 'session_meta', payload: { id, cwd: worktree } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [] } } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Clean Codex result' }] } } }
    ].map((value) => JSON.stringify(value)).join('\n'));

    await expect(readNativeWorkerResult('codex', worktree, id, startedAt, {
      codexHome,
      timeoutMs: 0
    })).resolves.toBe('Clean Codex result');
  });

  it('reads the final Cursor assistant turn and ignores tool calls', async () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cursor-result-'));
    roots.push(root);
    const worktree = join(root, 'worktree');
    mkdirSync(worktree);
    const cursorHome = join(root, 'cursor');
    const id = '01a057e7-ce82-7031-9fc4-cf3ec5800009';
    const slug = realpathSync(worktree).replace(/^[/\\]+/, '').replace(/[^A-Za-z0-9_-]/g, '-');
    const directory = join(cursorHome, 'projects', slug, 'agent-transcripts', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${id}.jsonl`), [
      { role: 'user', message: { content: [{ type: 'text', text: 'question' }] } },
      { role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell' }] } },
      { role: 'assistant', message: { content: [{ type: 'text', text: 'Clean Cursor result' }] } }
    ].map((value) => JSON.stringify(value)).join('\n'));

    await expect(readNativeWorkerResult('cursor', worktree, id, Date.now(), {
      cursorHome,
      timeoutMs: 0
    })).resolves.toBe('Clean Cursor result');
  });
});

function writeSession(directory: string, id: string, cwd: string): void {
  writeFileSync(join(directory, `rollout-${id}.jsonl`), `${JSON.stringify({
    type: 'session_meta',
    payload: { session_id: id, id, cwd }
  })}\n`);
}

function writeCursorTranscript(directory: string, id: string, modifiedAt: number): void {
  const target = join(directory, id);
  mkdirSync(target, { recursive: true });
  const path = join(target, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ role: 'user', message: { content: [] } })}\n`);
  const time = new Date(modifiedAt);
  utimesSync(path, time, time);
}
