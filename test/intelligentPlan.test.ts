import { describe, expect, it } from 'vitest';
import { intelligentPlanningPrompt, parseIntelligentPlan } from '../src/shared/intelligentPlan';
import type { AgentProfile } from '../src/shared/contracts';

const profile: AgentProfile = {
  id: 'profile-avery',
  name: 'Avery',
  provider: 'claude',
  model: 'claude-sonnet-4-5',
  instructions: 'Own accessible frontend work.',
  avatarSeed: 'avery',
  enabled: true,
  createdAt: 1,
  updatedAt: 1
};

describe('intelligent planning', () => {
  it('parses fenced planner output and hydrates trusted profile identity', () => {
    const result = parseIntelligentPlan(`noise\n\`\`\`json
      {"summary":"Use the UI specialist.","tasks":[{
        "title":"Build UI","role":"builder","deliverable":"Working UI",
        "instructions":"Implement and test the UI.","provider":"codex","profileId":"profile-avery"
      }]}
    \`\`\``, { providers: ['claude', 'codex'], profiles: [profile] });

    expect(result).toMatchObject({
      summary: 'Use the UI specialist.',
      tasks: [{
        provider: 'claude',
        profileId: 'profile-avery',
        agentName: 'Avery',
        model: 'claude-sonnet-4-5'
      }]
    });
  });

  it('rejects unavailable providers, profiles, and duplicate assignments', () => {
    const base = {
      title: 'Build',
      role: 'builder',
      deliverable: 'Feature',
      instructions: 'Implement the feature.'
    };
    expect(() => parseIntelligentPlan(JSON.stringify({ tasks: [{ ...base, provider: 'unknown' }] }), {
      providers: ['claude'], profiles: []
    })).toThrow('unavailable provider');
    expect(() => parseIntelligentPlan(JSON.stringify({ tasks: [{ ...base, profileId: 'profile-missing' }] }), {
      providers: ['claude'], profiles: [profile]
    })).toThrow('unavailable agent profile');
    expect(() => parseIntelligentPlan(JSON.stringify({ tasks: [
      { ...base, profileId: profile.id },
      { ...base, title: 'Review', profileId: profile.id }
    ] }), { providers: ['claude'], profiles: [profile] })).toThrow('more than once');
  });

  it('builds a bounded read-only JSON planning prompt', () => {
    const prompt = intelligentPlanningPrompt({
      orchestratorName: 'Michael',
      objective: 'Build settings',
      strategy: 'balanced',
      baseBranch: 'main',
      providers: ['claude', 'codex'],
      profiles: [profile]
    });
    expect(prompt).toContain('Do not modify files or Git state.');
    expect(prompt).toContain('Return exactly one JSON object');
    expect(prompt).toContain('cannot see another task\'s edits');
    expect(prompt).toContain('Never create a review');
    expect(prompt).toContain('unordered allowed pool');
    expect(prompt).toContain('Never assign roles from list position');
    expect(prompt).toContain('Relay performs post-integration verification separately');
    expect(prompt).toContain('No two tasks may edit the same file');
    expect(prompt).toContain('profile-avery');
    expect(prompt.length).toBeLessThanOrEqual(4_000);
  });

  it('rejects provider stereotypes and ignored explicit routing', () => {
    const builder = {
      title: 'Build feature',
      role: 'builder',
      deliverable: 'Working feature',
      instructions: 'Implement and test the feature.',
      provider: 'claude',
      assignmentReason: 'First provider'
    };
    const reviewer = {
      title: 'Review feature',
      role: 'reviewer',
      deliverable: 'Review findings',
      instructions: 'Review the implementation.',
      provider: 'codex',
      assignmentReason: 'Second provider'
    };
    expect(() => parseIntelligentPlan(JSON.stringify({ tasks: [builder, reviewer] }), {
      providers: ['claude', 'codex'],
      profiles: [],
      objective: 'Build the feature',
      strategy: 'balanced'
    })).toThrow(/post-implementation review/i);
    expect(() => parseIntelligentPlan(JSON.stringify({ tasks: [builder] }), {
      providers: ['claude', 'codex'],
      profiles: [],
      objective: 'Use Codex to implement the feature.',
      strategy: 'balanced'
    })).toThrow('explicit codex implementation assignment');
  });
});
