import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { OrchestratorActionBridge, validateOrchestratorAction } from '../src/main/orchestratorActions';
import type { ClaimedControlAction } from '../src/main/hive';
import type { OrchestratorActionResult } from '../src/shared/contracts';

describe('OrchestratorActionBridge', () => {
  it('executes one validated Michael action and records its result', async () => {
    const claims: ClaimedControlAction[] = [{
      fileName: 'action-input-1.json',
      path: '/hive/control/outbox/.processing/action-input-1.json',
      request: createAction()
    }];
    const results: OrchestratorActionResult[] = [];
    const execute = vi.fn(async (action) => ({
      version: 1 as const,
      actionId: action.id,
      kind: action.kind,
      status: 'completed' as const,
      completedAt: 200,
      runId: 'run-1',
      summary: 'Monitor run created.'
    }));
    const bridge = new OrchestratorActionBridge({
      hive: {
        claimControlActions: () => claims.splice(0),
        prepareControlAction: () => null,
        completeControlAction: (_claim, result) => results.push(result)
      },
      logger: loggerStub(),
      execute
    });

    await bridge.flush();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ kind: 'run.create', objective: 'Build it' }));
    expect(results).toEqual([expect.objectContaining({ status: 'completed', runId: 'run-1' })]);
  });

  it('rejects malformed and non-allowlisted actions without executing them', async () => {
    const claims: ClaimedControlAction[] = [{
      fileName: 'malicious.json',
      path: '/hive/control/outbox/.processing/malicious.json',
      request: { version: 1, id: 'action-bad', kind: 'shell.exec', createdAt: 100, command: 'rm -rf /' }
    }];
    const results: OrchestratorActionResult[] = [];
    const execute = vi.fn();
    const bridge = new OrchestratorActionBridge({
      hive: {
        claimControlActions: () => claims.splice(0),
        prepareControlAction: () => null,
        completeControlAction: (_claim, result) => results.push(result)
      },
      logger: loggerStub(),
      execute
    });

    await bridge.flush();

    expect(execute).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ actionId: 'action-bad', kind: 'unknown', status: 'rejected' });
    expect(results[0].error).toContain('allowlisted');
  });
});

describe('validateOrchestratorAction', () => {
  it('requires target ids and bounds concurrency', () => {
    expect(() => validateOrchestratorAction({
      ...createAction(),
      concurrency: 99
    })).toThrow('between 1 and 4');
    expect(() => validateOrchestratorAction({
      version: 1,
      id: 'action-stop',
      kind: 'run.stop',
      createdAt: 100
    })).toThrow('run id');
  });
});

function createAction() {
  return {
    version: 1,
    id: 'action-input-1',
    kind: 'run.create',
    createdAt: 100,
    inputId: 'control-input-1',
    objective: 'Build it',
    strategy: 'balanced',
    providers: ['claude'],
    concurrency: 1
  };
}

function loggerStub(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}
