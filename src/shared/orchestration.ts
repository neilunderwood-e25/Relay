import {
  PROVIDER_IDS,
  type ProviderId,
  type OrchestrationStrategy,
  type OrchestrationTaskRole
} from './contracts';

export interface PlannedTask {
  title: string;
  role: OrchestrationTaskRole;
  deliverable: string;
  instructions: string;
  provider: ProviderId;
  profileId?: string;
  agentName?: string;
  avatarSeed?: string;
  model?: string;
  profileInstructions?: string;
  assignmentReason?: string;
}

export interface AgentTarget {
  provider: ProviderId;
  profileId?: string;
  name?: string;
  avatarSeed?: string;
  model?: string | null;
  instructions?: string;
}

export interface VerificationAssignment {
  provider: ProviderId;
  reason: string;
}

export function planObjective(
  objective: string,
  providers: ProviderId[],
  strategy: OrchestrationStrategy = 'balanced'
): PlannedTask[] {
  return planObjectiveForAgents(
    objective,
    uniqueProviders(providers).map((provider) => ({ provider })),
    strategy
  );
}

export function planObjectiveForAgents(
  objective: string,
  agents: AgentTarget[],
  strategy: OrchestrationStrategy = 'balanced'
): PlannedTask[] {
  const workers = providerNeutralOrder(
    agents.filter((agent) => PROVIDER_IDS.includes(agent.provider)).slice(0, 4),
    objective
  );
  if (workers.length === 0) return [];

  const pieces = objective
    .split(/\r?\n|;+/)
    .map((part) => part.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

  if (workers.length === 1) {
    return [{
      ...targetFields(workers[0]),
      role: 'owner',
      title: shortTitle(objective, 'Own delivery'),
      deliverable: 'Working change',
      instructions: `Own the objective end to end. Implement it, validate it, and report the result: ${objective}`,
      assignmentReason: workers[0].profileId ? 'Profile specialty' : 'Only provider'
    }];
  }

  if (strategy === 'audit') {
    return workers.map((agent, index) => ({
      ...targetFields(agent),
      role: 'investigator',
      title: index === 0 ? 'Primary audit' : 'Second opinion',
      deliverable: index === 0 ? 'Findings and risks' : 'Independent findings',
      instructions: `${index === 0 ? 'Investigate' : 'Independently challenge'} the objective and report concrete evidence, risks, and recommendations. Do not modify files unless the objective explicitly requests fixes: ${objective}`,
      assignmentReason: 'Independent audit'
    }));
  }

  if (strategy === 'parallel') {
    const remaining = [...workers];
    return workers.map((agent, index) => {
      const hasExplicitSlice = pieces.length >= workers.length;
      const slice = hasExplicitSlice ? pieces[index] : objective;
      const explicit = explicitProviderForRole(slice, 'implementation');
      const requestedIndex = explicit ? remaining.findIndex((worker) => worker.provider === explicit) : -1;
      const assigned = remaining.splice(requestedIndex >= 0 ? requestedIndex : 0, 1)[0] ?? agent;
      return {
        ...targetFields(assigned),
        role: 'specialist',
        title: hasExplicitSlice
          ? shortTitle(slice, `Workstream ${index + 1}`)
          : index === 0 ? 'Product slice' : 'Quality slice',
        deliverable: hasExplicitSlice
          ? `Completed workstream ${index + 1}`
          : index === 0 ? 'Production implementation' : 'Tests and safeguards',
        instructions: hasExplicitSlice
          ? `Own this independent workstream and validate it: ${slice}`
          : index === 0
            ? `Implement the production-facing portion of this objective: ${objective}`
            : `Own an independent quality or safeguard workstream that does not depend on another worker's edits: ${objective}`,
        assignmentReason: explicit ? 'Explicit request' : 'Parallel balance'
      };
    });
  }

  const explicit = explicitProviderForRole(objective, 'implementation');
  const profileMatch = bestProfileMatch(workers, objective);
  const owner = explicit
    ? workers.find((worker) => worker.provider === explicit) ?? profileMatch ?? workers[0]
    : profileMatch ?? workers[0];
  return [{
    ...targetFields(owner),
    role: 'owner',
    title: shortTitle(objective, 'Own delivery'),
    deliverable: 'Working implementation',
    instructions: `Own the objective end to end, including implementation-specific tests and validation: ${objective}`,
    assignmentReason: explicit ? 'Explicit request' : profileMatch ? 'Profile specialty' : 'Objective rotation'
  }];
}

export function recommendedVerificationAssignment(
  objective: string,
  agents: AgentTarget[],
  tasks: PlannedTask[]
): VerificationAssignment | undefined {
  const providers = uniqueProviders(agents.map(({ provider }) => provider));
  if (providers.length === 0) return undefined;
  const explicit = explicitProviderForRole(objective, 'review');
  if (explicit && providers.includes(explicit)) return { provider: explicit, reason: 'Explicit request' };

  const usage = new Map(providers.map((provider) => [provider, tasks.filter((task) => task.provider === provider).length]));
  const ordered = providerNeutralOrder(providers.map((provider) => ({ provider })), `${objective}:verification`);
  const minimum = Math.min(...ordered.map(({ provider }) => usage.get(provider) ?? 0));
  const selected = ordered.find(({ provider }) => (usage.get(provider) ?? 0) === minimum) ?? ordered[0];
  return { provider: selected.provider, reason: providers.length === 1 ? 'Only provider' : 'Independent check' };
}

export function explicitProviderForRole(
  objective: string,
  role: 'implementation' | 'review'
): ProviderId | undefined {
  const verbs = role === 'implementation'
    ? '(?:implement(?:ation|s|ing)?|build(?:s|ing)?|creat(?:e|es|ing)|cod(?:e|es|ing)|develop(?:ment|s|ing)?|fix(?:es|ing)?|refactor(?:s|ing)?|own(?:s|ing)?)'
    : '(?:review(?:s|ing)?|test(?:s|ing)?|audit(?:s|ing)?|verif(?:y|ies|ying|ication)|check(?:s|ing)?|inspect(?:s|ing|ion)?|validat(?:e|es|ing|ion))';
  const aliases: Record<ProviderId, string> = {
    claude: 'claude(?:\\s+code)?',
    codex: 'codex(?:\\s+cli)?',
    cursor: 'cursor(?:\\s+agent|\\s+cli)?'
  };
  for (const provider of PROVIDER_IDS) {
    const alias = aliases[provider];
    const qualifiers = '(?:(?:the|an?|independent|primary|final|focused)\\s+){0,4}';
    const patterns = [
      new RegExp(`(?:use|have|ask|let|assign)\\s+${alias}\\s+(?:to|for)\\s+${qualifiers}${verbs}`, 'i'),
      new RegExp(`${alias}\\s+(?:to|for)\\s+${qualifiers}${verbs}`, 'i'),
      new RegExp(`${alias}\\s+(?:(?:should|must|will)\\s+|to\\s+)?${verbs}`, 'i'),
      new RegExp(`${verbs}[^.;\\n]{0,32}(?:with|using|by)\\s+${alias}`, 'i')
    ];
    if (patterns.some((pattern) => pattern.test(objective))) return provider;
  }
  return undefined;
}

function targetFields(agent: AgentTarget): Pick<
  PlannedTask,
  'provider' | 'profileId' | 'agentName' | 'avatarSeed' | 'model' | 'profileInstructions'
> {
  return {
    provider: agent.provider,
    profileId: agent.profileId,
    agentName: agent.name,
    avatarSeed: agent.avatarSeed,
    model: agent.model ?? undefined,
    profileInstructions: agent.instructions
  };
}

function uniqueProviders(providers: ProviderId[]): ProviderId[] {
  return [...new Set(providers.filter((provider): provider is ProviderId => PROVIDER_IDS.includes(provider)))];
}

function providerNeutralOrder(agents: AgentTarget[], objective: string): AgentTarget[] {
  const ordered = [...agents].sort((left, right) => agentKey(left).localeCompare(agentKey(right)));
  if (ordered.length < 2) return ordered;
  const offset = stableHash(objective.trim().toLowerCase()) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
}

function agentKey(agent: AgentTarget): string {
  return `${agent.provider}:${agent.profileId ?? ''}:${agent.name ?? ''}`;
}

function bestProfileMatch(agents: AgentTarget[], objective: string): AgentTarget | undefined {
  const objectiveTokens = significantTokens(objective);
  const matches = agents
    .filter((agent) => agent.profileId && agent.instructions)
    .map((agent) => ({
      agent,
      score: [...significantTokens(agent.instructions ?? '')].filter((token) => objectiveTokens.has(token)).length
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || agentKey(left.agent).localeCompare(agentKey(right.agent)));
  return matches[0]?.agent;
}

function significantTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function shortTitle(value: string, fallback: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 44);
}
