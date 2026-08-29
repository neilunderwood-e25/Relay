import {
  DEFAULT_RELAY_PREFERENCES,
  ORCHESTRATION_STRATEGIES,
  PROVIDER_IDS,
  type OrchestrationStrategy,
  type PreferencesUpdateRequest,
  type ProviderId,
  type RelayPreferences
} from '../shared/contracts';

export function normalizePreferences(request?: Partial<PreferencesUpdateRequest>): RelayPreferences {
  const defaultStrategy = ORCHESTRATION_STRATEGIES.includes(request?.defaultStrategy as OrchestrationStrategy)
    ? request!.defaultStrategy!
    : DEFAULT_RELAY_PREFERENCES.defaultStrategy;
  const maxConcurrentAgents = Number.isFinite(request?.maxConcurrentAgents)
    ? Math.max(1, Math.min(4, Math.round(request!.maxConcurrentAgents!)))
    : DEFAULT_RELAY_PREFERENCES.maxConcurrentAgents;
  const verificationProvider = request?.verificationProvider === null
    || PROVIDER_IDS.includes(request?.verificationProvider as ProviderId)
    ? request?.verificationProvider ?? null
    : DEFAULT_RELAY_PREFERENCES.verificationProvider;
  return { defaultStrategy, maxConcurrentAgents, verificationProvider };
}
