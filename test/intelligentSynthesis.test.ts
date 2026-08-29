import { describe, expect, it } from 'vitest';
import type { OrchestrationRun, OrchestrationTask } from '../src/shared/contracts';
import {
  fallbackSynthesis,
  intelligentSynthesisPrompt,
  parseIntelligentSynthesis
} from '../src/shared/intelligentSynthesis';

const run: OrchestrationRun = {
  id: 'run-1',
  objective: 'Build settings',
  repoRoot: '/repo',
  baseBranch: 'main',
  status: 'summarizing',
  strategy: 'balanced',
  concurrency: 1,
  createdAt: 100,
  updatedAt: 200
};

const task: OrchestrationTask = {
  id: 'task-1',
  runId: 'run-1',
  ordinal: 0,
  title: 'Build UI',
  instructions: 'Build it.',
  role: 'builder',
  deliverable: 'Working UI',
  provider: 'claude',
  status: 'completed',
  attempt: 1,
  summary: 'Implemented the UI and ran focused tests.',
  createdAt: 100,
  updatedAt: 200
};

describe('intelligent synthesis', () => {
  it('builds a bounded read-only outcome prompt', () => {
    const prompt = intelligentSynthesisPrompt({ orchestratorName: 'Michael', run, tasks: [task] });
    expect(prompt).toContain('Do not modify files');
    expect(prompt).toContain('Implemented the UI');
    expect(prompt.length).toBeLessThanOrEqual(4_000);
  });

  it('removes terminal formatting and bounds model output', () => {
    expect(parseIntelligentSynthesis('\u001b[32mDelivered and tested.\u001b[0m')).toBe('Delivered and tested.');
    expect(() => parseIntelligentSynthesis('')).toThrow('empty outcome');
  });

  it('produces a deterministic blocker fallback', () => {
    const blocked = { ...task, status: 'blocked' as const, blocker: 'API schema is unavailable.' };
    expect(fallbackSynthesis(run, [blocked])).toContain('API schema is unavailable.');
  });
});
