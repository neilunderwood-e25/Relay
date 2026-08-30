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
    expect(prompt).toContain('No two tasks may edit the same file');
    expect(prompt).toContain('profile-avery');
    expect(prompt.length).toBeLessThanOrEqual(4_000);
  });
});
