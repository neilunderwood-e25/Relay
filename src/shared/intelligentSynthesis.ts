import type { OrchestrationRun, OrchestrationTask } from './contracts';

const MAX_PROMPT = 4_000;
const MAX_SUMMARY = 2_000;

export function intelligentSynthesisPrompt({
  orchestratorName,
  run,
  tasks
}: {
  orchestratorName: string;
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
}): string {
  const outcomes = tasks.map((task) => [
    `Task ${task.ordinal + 1}: ${task.title}`,
    `Agent: ${task.agentName ?? task.provider}`,
    `Status: ${task.status}`,
    `Deliverable: ${task.deliverable}`,
    task.blocker ? `Blocker: ${task.blocker}` : '',
    task.error ? `Error: ${task.error}` : '',
    task.summary ? `Worker report: ${compact(task.summary, 700)}` : ''
  ].filter(Boolean).join('\n')).join('\n\n');

  return [
    `You are ${orchestratorName}, the orchestration lead inside Relay.`,
    'Write the final outcome for this coding run from the worker reports below.',
    'Do not modify files, run commands, or claim checks that are not present in the reports.',
    'Use plain text with at most 140 words. Start with one verdict sentence, then short bullets for delivered work, checks, and any blocker or follow-up.',
    `Objective: ${run.objective}`,
    `Base branch: ${run.baseBranch}`,
    `Plan: ${run.planningSummary ?? 'No model rationale recorded.'}`,
    outcomes
  ].join('\n\n').slice(0, MAX_PROMPT);
}

export function parseIntelligentSynthesis(output: string): string {
  const plain = output
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!plain) throw new Error('Michael returned an empty outcome.');
  return plain.slice(-MAX_SUMMARY);
}

export function fallbackSynthesis(run: OrchestrationRun, tasks: OrchestrationTask[]): string {
  const completed = tasks.filter((task) => task.status === 'completed');
  const blocked = tasks.filter((task) => ['blocked', 'failed'].includes(task.status));
  const verdict = blocked.length === 0
    ? `Completed ${completed.length} of ${tasks.length} planned tasks for “${run.objective}”.`
    : `Completed ${completed.length} of ${tasks.length} planned tasks; ${blocked.length} need attention.`;
  const details = tasks.map((task) => {
    const outcome = task.blocker ?? task.error ?? compact(task.summary ?? task.deliverable, 220);
    return `- ${task.title}: ${task.status}${outcome ? ` — ${outcome}` : ''}`;
  });
  return [verdict, ...details].join('\n').slice(0, MAX_SUMMARY);
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}
