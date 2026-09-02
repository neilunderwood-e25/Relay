import type { ProviderId } from './contracts';

export interface OrchestratorModelOption {
  id: string | null;
  label: string;
}

export const DEFAULT_ORCHESTRATOR_PROVIDER: ProviderId = 'claude';

export const ORCHESTRATOR_MODELS: Record<ProviderId, readonly OrchestratorModelOption[]> = {
  claude: [
    { id: null, label: 'CLI default' },
    { id: 'claude-opus-5', label: 'Opus 5 · 1M' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8' },
    { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-fable-5', label: 'Fable 5' }
  ],
  codex: [
    { id: null, label: 'CLI default' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' }
  ],
  cursor: [
    { id: null, label: 'CLI default' }
  ]
};

export function isOrchestratorModel(provider: ProviderId, model: unknown): model is string | null {
  if (model === null) return true;
  if (provider === 'cursor') {
    return typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/\[\],= -]{0,159}$/.test(model);
  }
  return (
    typeof model === 'string'
    && ORCHESTRATOR_MODELS[provider].some((option) => option.id === model)
  );
}

export function orchestratorModelLabel(provider: ProviderId, model: string | null): string {
  return ORCHESTRATOR_MODELS[provider].find((option) => option.id === model)?.label ?? model ?? 'CLI default';
}
