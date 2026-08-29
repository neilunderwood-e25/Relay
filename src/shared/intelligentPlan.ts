import type {
  AgentProfile,
  OrchestrationStrategy,
  OrchestrationTaskRole,
  ProviderId
} from './contracts';
import type { PlannedTask } from './orchestration';

const ROLES: OrchestrationTaskRole[] = ['owner', 'builder', 'specialist', 'reviewer', 'investigator'];

export interface ParsedIntelligentPlan {
  summary: string;
  tasks: PlannedTask[];
}

export interface IntelligentPlanContext {
  providers: ProviderId[];
  profiles: AgentProfile[];
}

export function parseIntelligentPlan(output: string, context: IntelligentPlanContext): ParsedIntelligentPlan {
  const value = parseJsonObject(stripTerminalFormatting(output));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Planner did not return a JSON object.');
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tasks) || record.tasks.length < 1 || record.tasks.length > 4) {
    throw new Error('Planner must return between one and four tasks.');
  }

  const available = new Set(context.providers);
  const profiles = new Map(context.profiles.map((profile) => [profile.id, profile]));
  const usedProfiles = new Set<string>();
  const tasks = record.tasks.map((candidate, index): PlannedTask => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Planner task ${index + 1} is invalid.`);
    }
    const task = candidate as Record<string, unknown>;
    const profileId = optionalString(task.profileId, 80);
    const profile = profileId ? profiles.get(profileId) : undefined;
    if (profileId && !profile) throw new Error(`Planner selected an unavailable agent profile: ${profileId}.`);
    if (profileId && usedProfiles.has(profileId)) throw new Error(`Planner selected ${profileId} more than once.`);
    if (profileId) usedProfiles.add(profileId);

    const requestedProvider = optionalString(task.provider, 16);
    const provider = profile?.provider ?? (requestedProvider as ProviderId | undefined);
    if (!provider || !available.has(provider)) throw new Error(`Planner task ${index + 1} selected an unavailable provider.`);
    const role = ROLES.includes(task.role as OrchestrationTaskRole)
      ? task.role as OrchestrationTaskRole
      : 'specialist';

    return {
      provider,
      profileId: profile?.id,
      agentName: profile?.name,
      avatarSeed: profile?.avatarSeed,
      model: profile?.model ?? undefined,
      profileInstructions: profile?.instructions,
      role,
      title: requiredString(task.title, 80, `Planner task ${index + 1} needs a title.`),
      instructions: requiredString(task.instructions, 2_000, `Planner task ${index + 1} needs instructions.`),
      deliverable: requiredString(task.deliverable, 160, `Planner task ${index + 1} needs a deliverable.`)
    };
  });

  return {
    summary: optionalString(record.summary, 500) || 'Michael created a model-driven execution plan.',
    tasks
  };
}

export function intelligentPlanningPrompt({
  orchestratorName,
  objective,
  strategy,
  baseBranch,
  providers,
  profiles,
  replanContext
}: {
  orchestratorName: string;
  objective: string;
  strategy: OrchestrationStrategy;
  baseBranch: string;
  providers: ProviderId[];
  profiles: AgentProfile[];
  replanContext?: string;
}): string {
  const roster = profiles.length > 0
    ? profiles.map((profile) => ({
        profileId: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model,
        specialty: profile.instructions || 'General coding'
      }))
    : [];
  return [
    `You are ${orchestratorName}, the planning orchestrator inside Relay.`,
    `Objective: ${objective}`,
    `Run mode: ${strategy}. Base branch: ${baseBranch}.`,
    `Available CLI providers: ${providers.join(', ')}.`,
    `Available saved agents: ${JSON.stringify(roster)}.`,
    replanContext ? `Previous run evidence: ${replanContext.replace(/\s+/g, ' ').slice(0, 1_200)}.` : '',
    'Inspect the repository only as needed to produce a concrete execution plan. Do not modify files or Git state.',
    'Return exactly one JSON object and no Markdown. Use this schema:',
    '{"summary":"short plan rationale","tasks":[{"title":"short title","role":"owner|builder|specialist|reviewer|investigator","deliverable":"observable result","instructions":"specific bounded task","provider":"claude|codex","profileId":"optional profile id from the roster"}]}',
    'Create 1 to 4 independently executable tasks. Use each selected profile at most once. Keep responsibilities non-overlapping and include validation ownership.'
  ].filter(Boolean).join('\n\n').slice(0, 4_000);
}

function parseJsonObject(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  const source = fenced ?? output;
  let fallback: unknown;
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(source.slice(start, index + 1)) as unknown;
        if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).tasks)) {
          return parsed;
        }
        fallback = parsed;
      } catch {
        // Keep scanning for the next complete object.
      }
      break;
    }
  }
  return fallback;
}

function stripTerminalFormatting(value: string): string {
  return value
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\r/g, '')
    .trim();
}

function requiredString(value: unknown, max: number, error: string): string {
  const result = optionalString(value, max);
  if (!result) throw new Error(error);
  return result;
}

function optionalString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}
