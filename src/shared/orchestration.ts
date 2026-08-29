import type {
  OrchestrationStrategy,
  OrchestrationTaskRole,
  ProviderId
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
}

export interface AgentTarget {
  provider: ProviderId;
  profileId?: string;
  name?: string;
  avatarSeed?: string;
  model?: string | null;
  instructions?: string;
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
  const workers = agents.filter((agent) => ['claude', 'codex'].includes(agent.provider)).slice(0, 4);
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
      instructions: `Own the objective end to end. Implement it, validate it, and report the result: ${objective}`
    }];
  }

  if (strategy === 'audit') {
    return workers.map((agent, index) => ({
      ...targetFields(agent),
      role: 'investigator',
      title: index === 0 ? 'Primary audit' : 'Second opinion',
      deliverable: index === 0 ? 'Findings and risks' : 'Independent findings',
      instructions: `${index === 0 ? 'Investigate' : 'Independently challenge'} the objective and report concrete evidence, risks, and recommendations. Do not modify files unless the objective explicitly requests fixes: ${objective}`
    }));
  }

  if (strategy === 'parallel') {
    return workers.map((agent, index) => {
      const hasExplicitSlice = pieces.length >= workers.length;
      const slice = hasExplicitSlice ? pieces[index] : objective;
      return {
        ...targetFields(agent),
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
            : `Own the test, validation, and safeguard portion of this objective without duplicating the production implementation: ${objective}`
      };
    });
  }

  return workers.map((agent, index) => index === 0 ? {
    ...targetFields(agent),
    role: 'builder',
    title: shortTitle(objective, 'Build solution'),
    deliverable: 'Working implementation',
    instructions: `Implement the objective end to end and run proportionate checks: ${objective}`
  } : {
    ...targetFields(agent),
    role: 'reviewer',
    title: 'Validate solution',
    deliverable: 'Tests and review',
    instructions: `Independently inspect the objective. Add focused tests or safeguards, identify integration risks, and fix issues within your workstream: ${objective}`
  });
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
  return [...new Set(providers.filter((provider): provider is ProviderId => ['claude', 'codex'].includes(provider)))];
}

function shortTitle(value: string, fallback: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, 44);
}
