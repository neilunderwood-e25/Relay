import type { ProviderId } from '../shared/contracts';

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  command: string;
  versionArgs: string[];
  workerArgs(prompt: string, model?: string | null): string[];
  verificationArgs(prompt: string, model?: string | null): string[];
}

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    workerArgs: (prompt, model) => [
      ...(model ? ['--model', model] : []),
      '--print', '--permission-mode', 'acceptEdits', '--output-format', 'text', '--no-session-persistence', prompt
    ],
    verificationArgs: (prompt, model) => [
      ...(model ? ['--model', model] : []),
      '--print', '--permission-mode', 'plan', '--output-format', 'text', '--no-session-persistence', prompt
    ]
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    workerArgs: (prompt, model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      'exec', '--sandbox', 'workspace-write', '--color', 'always', '--ephemeral', prompt
    ],
    verificationArgs: (prompt, model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      'exec', '--sandbox', 'read-only', '--color', 'always', '--ephemeral', prompt
    ]
  }
};

export function providerAdapters(): ProviderAdapter[] {
  return [ADAPTERS.claude, ADAPTERS.codex];
}

export function providerAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}
