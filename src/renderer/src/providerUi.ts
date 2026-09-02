import { ChatGptIcon, ClaudeIcon, Cursor02Icon } from '@hugeicons/core-free-icons';
import type { IconSvgElement } from '@hugeicons/react';
import {
  DEFAULT_AGENT_NAMES,
  type ProviderCapability,
  type ProviderId
} from '../../shared/contracts';
import {
  ORCHESTRATOR_MODELS,
  type OrchestratorModelOption
} from '../../shared/orchestratorModels';

export type ProviderState = 'ready' | 'signin' | 'missing' | 'error';

export function providerIcon(provider: ProviderId): IconSvgElement {
  if (provider === 'claude') return ClaudeIcon;
  if (provider === 'codex') return ChatGptIcon;
  return Cursor02Icon;
}

export function providerLabel(provider: ProviderId | null | undefined): string {
  return provider ? DEFAULT_AGENT_NAMES[provider] : 'Automatic';
}

export function providerCliLabel(provider: ProviderId): string {
  if (provider === 'claude') return 'Claude CLI';
  if (provider === 'codex') return 'Codex CLI';
  return 'Cursor CLI';
}

export function providerReady(provider: { available: boolean; authenticated?: boolean | null }): boolean {
  return provider.available && provider.authenticated !== false;
}

export function providerState(provider: ProviderCapability): ProviderState {
  if (!provider.available && provider.executablePath) return 'error';
  if (!provider.available) return 'missing';
  if (provider.authenticated === false) return 'signin';
  return 'ready';
}

export function providerStatusLabel(provider: ProviderCapability): string {
  const state = providerState(provider);
  if (state === 'signin') return 'Sign in';
  if (state === 'missing') return 'Missing';
  if (state === 'error') return 'Error';
  return 'Ready';
}

export function providerStatusDetail(provider: ProviderCapability): string {
  if (providerState(provider) === 'ready') {
    const modelCount = provider.models?.length ?? 0;
    return [provider.version, modelCount > 0 ? `${modelCount} models` : null]
      .filter(Boolean)
      .join(' · ') || 'CLI ready';
  }
  return provider.authenticationError ?? provider.error ?? `${providerCliLabel(provider.id)} unavailable`;
}

export function providerModelOptions(
  provider: ProviderId,
  capability?: ProviderCapability
): OrchestratorModelOption[] {
  const options = [
    ...ORCHESTRATOR_MODELS[provider],
    ...(capability?.models ?? []).map((id) => ({ id, label: id }))
  ];
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.id ?? '__cli_default__';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function providerModelLabel(provider: ProviderId, model: string | null | undefined): string {
  return ORCHESTRATOR_MODELS[provider].find((option) => option.id === (model ?? null))?.label
    ?? model
    ?? 'CLI default';
}
