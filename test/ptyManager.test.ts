import type { Logger } from 'pino';
import * as nodePty from 'node-pty';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyManager, terminalEnvironment } from '../src/main/pty';
import { resolveExecutable } from '../src/main/providers';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../src/main/providers', () => ({ resolveExecutable: vi.fn() }));

describe('PtyManager orchestrator session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveExecutable).mockResolvedValue('/usr/bin/claude');
    vi.mocked(nodePty.spawn).mockReturnValue({
      pid: 4242,
      onData: vi.fn(),
      onExit: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      clear: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      handleFlowControl: false,
      process: 'claude',
      cols: 120,
      rows: 32
    });
  });

  it('coalesces concurrent starts into one persistent orchestrator PTY', async () => {
    const manager = new PtyManager({ logger: loggerStub() });
    const request = {
      provider: 'claude' as const,
      role: 'orchestrator' as const,
      avatarSeed: 'relay-orchestrator',
      cwd: process.cwd(),
      name: 'Michael',
      cols: 120,
      rows: 32
    };

    const [first, second] = await Promise.all([manager.spawn(request), manager.spawn(request)]);
    const third = await manager.spawn(request);

    expect(first.id).toBe(second.id);
    expect(third.id).toBe(first.id);
    expect(nodePty.spawn).toHaveBeenCalledTimes(1);
    expect(manager.list()).toHaveLength(1);
  });

  it('submits a multi-line control message atomically before later terminal input', async () => {
    const manager = new PtyManager({ logger: loggerStub() });
    const terminal = await manager.spawn({
      provider: 'claude',
      role: 'orchestrator',
      cwd: process.cwd(),
      name: 'Michael'
    });
    const child = vi.mocked(nodePty.spawn).mock.results[0].value;

    const submission = manager.submit(terminal.id, 'line one\nline two');
    const manualInput = manager.write(terminal.id, 'x');
    await Promise.all([submission, manualInput]);

    expect(child.write).toHaveBeenNthCalledWith(1, '\x1b[200~line one\nline two\x1b[201~');
    expect(child.write).toHaveBeenNthCalledWith(2, '\r');
    expect(child.write).toHaveBeenNthCalledWith(3, 'x');
  });

  it('does not leak unrelated host secrets into CLI processes', () => {
    const environment = terminalEnvironment({
      HOME: '/Users/test',
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'provider-key',
      AWS_SECRET_ACCESS_KEY: 'unrelated-secret',
      RELAY_INTERNAL_TOKEN: 'internal-secret'
    });

    expect(environment).toMatchObject({
      HOME: '/Users/test', PATH: '/usr/bin', OPENAI_API_KEY: 'provider-key',
      TERM: 'xterm-256color', TERM_PROGRAM: 'Relay'
    });
    expect(environment).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(environment).not.toHaveProperty('RELAY_INTERNAL_TOKEN');
  });
});

function loggerStub(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}
