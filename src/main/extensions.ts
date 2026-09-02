import { randomUUID } from 'node:crypto';
import {
  PROVIDER_IDS,
  type AgentProfile,
  type AgentProfileSaveRequest,
  type OperationResult,
  type OrchestrationStrategy,
  type OrchestrationTemplate,
  type OrchestrationTemplateSaveRequest,
  type ProviderId
} from '../shared/contracts';
import type { RelayDatabase } from './database';

const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,99}$/;
const ID_PATTERN = /^(?:profile|template)-[a-z0-9-]{4,64}$/;

export class ExtensionRegistry {
  constructor(private readonly database: RelayDatabase) {}

  listProfiles(): AgentProfile[] {
    return this.database.listAgentProfiles();
  }

  listTemplates(): OrchestrationTemplate[] {
    return this.database.listOrchestrationTemplates();
  }

  saveProfile(request: AgentProfileSaveRequest): AgentProfile {
    const name = cleanName(request?.name);
    if (!name || !NAME_PATTERN.test(name)) throw new Error('Use a profile name between 1 and 32 characters.');
    const requestedProvider = request?.provider;
    if (!requestedProvider || !PROVIDER_IDS.includes(requestedProvider)) throw new Error('Choose a supported provider.');
    const provider = request.provider as ProviderId;
    const model = cleanModel(request?.model);
    const instructions = cleanInstructions(request?.instructions);
    const existing = request?.id ? this.requireProfile(request.id) : undefined;
    const now = Date.now();
    const profile: AgentProfile = {
      id: existing?.id ?? `profile-${randomUUID().slice(0, 12)}`,
      name,
      provider,
      model,
      instructions,
      avatarSeed: cleanAvatarSeed(request.avatarSeed) || existing?.avatarSeed || `profile-${randomUUID().slice(0, 12)}`,
      enabled: request.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.database.upsertAgentProfile(profile);
    this.database.appendEvent(existing ? 'extension.profile.updated' : 'extension.profile.created', {
      profileId: profile.id,
      name: profile.name,
      provider: profile.provider
    });
    return profile;
  }

  deleteProfile(id: string): OperationResult {
    if (!validId(id, 'profile')) return { ok: false, error: 'Invalid agent profile.' };
    if (!this.database.deleteAgentProfile(id)) return { ok: false, error: 'Agent profile was not found.' };
    for (const template of this.database.listOrchestrationTemplates()) {
      if (!template.profileIds.includes(id)) continue;
      template.profileIds = template.profileIds.filter((profileId) => profileId !== id);
      template.updatedAt = Date.now();
      this.database.upsertOrchestrationTemplate(template);
    }
    this.database.appendEvent('extension.profile.deleted', { profileId: id });
    return { ok: true };
  }

  saveTemplate(request: OrchestrationTemplateSaveRequest): OrchestrationTemplate {
    const name = cleanName(request?.name);
    if (!name || !NAME_PATTERN.test(name)) throw new Error('Use a template name between 1 and 32 characters.');
    const objective = (request?.objective ?? '').trim();
    if (!objective || objective.length > 2_000) throw new Error('Use an objective between 1 and 2,000 characters.');
    const strategy = validStrategy(request.strategy) ? request.strategy : 'balanced';
    const profileIds = [...new Set((request.profileIds ?? []).filter((id) => validId(id, 'profile')))]
      .filter((id) => this.database.getAgentProfile(id));
    if (profileIds.length > 4) throw new Error('A template supports up to four agent profiles.');
    const existing = request.id ? this.requireTemplate(request.id) : undefined;
    const now = Date.now();
    const template: OrchestrationTemplate = {
      id: existing?.id ?? `template-${randomUUID().slice(0, 12)}`,
      name,
      objective,
      strategy,
      profileIds,
      concurrency: clampConcurrency(request.concurrency ?? existing?.concurrency),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    this.database.upsertOrchestrationTemplate(template);
    this.database.appendEvent(existing ? 'extension.template.updated' : 'extension.template.created', {
      templateId: template.id,
      name: template.name,
      profileCount: template.profileIds.length
    });
    return template;
  }

  deleteTemplate(id: string): OperationResult {
    if (!validId(id, 'template')) return { ok: false, error: 'Invalid template.' };
    if (!this.database.deleteOrchestrationTemplate(id)) return { ok: false, error: 'Template was not found.' };
    this.database.appendEvent('extension.template.deleted', { templateId: id });
    return { ok: true };
  }

  private requireProfile(id: string): AgentProfile {
    if (!validId(id, 'profile')) throw new Error('Invalid agent profile.');
    const profile = this.database.getAgentProfile(id);
    if (!profile) throw new Error('Agent profile was not found.');
    return profile;
  }

  private requireTemplate(id: string): OrchestrationTemplate {
    if (!validId(id, 'template')) throw new Error('Invalid template.');
    const template = this.database.getOrchestrationTemplate(id);
    if (!template) throw new Error('Template was not found.');
    return template;
  }
}

function cleanName(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 32) : '';
}

function cleanModel(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !MODEL_PATTERN.test(value.trim())) throw new Error('Use a valid model identifier.');
  return value.trim();
}

function cleanInstructions(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 2_000) throw new Error('Keep profile instructions under 2,000 characters.');
  return value.trim();
}

function cleanAvatarSeed(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) : '';
}

function validId(id: unknown, type: 'profile' | 'template'): id is string {
  return typeof id === 'string' && id.startsWith(`${type}-`) && ID_PATTERN.test(id);
}

function validStrategy(value: unknown): value is OrchestrationStrategy {
  return ['balanced', 'parallel', 'audit'].includes(value as OrchestrationStrategy);
}

function clampConcurrency(value: unknown): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(4, Math.round(value as number))) : 2;
}
