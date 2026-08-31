import type { ProviderId } from '../shared/contracts';

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  command: string;
  versionArgs: string[];
  orchestratorArgs(prompt: string, hiveRoot: string, model?: string | null): string[];
  planningArgs(prompt: string, model?: string | null): string[];
  interactiveWorkerArgs(model?: string | null, nativeSessionId?: string): string[];
  resumeWorkerArgs(model?: string | null, nativeSessionId?: string): string[];
  workerArgs(prompt: string, model?: string | null): string[];
  verificationArgs(prompt: string, model?: string | null): string[];
}

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    orchestratorArgs: (prompt, hiveRoot, model) => [
      ...(model ? ['--model', model] : []),
      '--name', 'Relay Michael',
      '--add-dir', hiveRoot,
      '--safe-mode',
      '--restricted',
      '--strict-mcp-config',
      '--no-chrome',
      '--permission-mode', 'acceptEdits',
      '--tools', 'Read,Glob,Grep,Edit,Write',
      '--allowedTools', 'Read,Glob,Grep,Edit,Write',
      '--append-system-prompt', prompt
    ],
    planningArgs: (prompt, model) => [
      ...(model ? ['--model', model] : []),
      '--print', '--permission-mode', 'plan', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--no-session-persistence', prompt
    ],
    interactiveWorkerArgs: (model, nativeSessionId) => [
      ...(model ? ['--model', model] : []),
      ...(nativeSessionId ? ['--session-id', nativeSessionId] : []),
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Read,Glob,Grep,Edit,Write',
      '--no-chrome'
    ],
    resumeWorkerArgs: (model, nativeSessionId) => [
      ...(model ? ['--model', model] : []),
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Read,Glob,Grep,Edit,Write',
      '--no-chrome',
      ...(nativeSessionId ? ['--resume', nativeSessionId] : ['--continue'])
    ],
    workerArgs: (prompt, model) => [
      ...(model ? ['--model', model] : []),
      '--print',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Read,Glob,Grep,Edit,Write',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      prompt
    ],
    verificationArgs: (prompt, model) => [
      ...(model ? ['--model', model] : []),
      '--print',
      '--permission-mode', 'dontAsk',
      '--tools', 'Bash,Read,Glob,Grep',
      '--allowedTools', 'Bash,Read,Glob,Grep',
      '--verbose',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--no-session-persistence',
      prompt
    ]
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    orchestratorArgs: (prompt, hiveRoot, model) => [
      ...(model ? ['--model', model] : []),
      '--ask-for-approval', 'never',
      '--sandbox', 'workspace-write',
      '--add-dir', hiveRoot,
      '--no-alt-screen',
      prompt
    ],
    planningArgs: (prompt, model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      'exec', '--sandbox', 'read-only', '--color', 'never', '--json', '--ephemeral', prompt
    ],
    interactiveWorkerArgs: (model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      '--sandbox', 'workspace-write',
      '--no-alt-screen'
    ],
    resumeWorkerArgs: (model, nativeSessionId) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      '--sandbox', 'workspace-write',
      '--no-alt-screen',
      'resume', ...(nativeSessionId ? [nativeSessionId] : ['--last'])
    ],
    workerArgs: (prompt, model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      'exec', '--sandbox', 'workspace-write', '--color', 'never', '--json', '--ephemeral', prompt
    ],
    verificationArgs: (prompt, model) => [
      '--ask-for-approval', 'never', ...(model ? ['--model', model] : []),
      'exec', '--sandbox', 'read-only', '--color', 'never', '--json', '--ephemeral', prompt
    ]
  }
};

export function providerAdapters(): ProviderAdapter[] {
  return [ADAPTERS.claude, ADAPTERS.codex];
}

export function providerAdapter(id: ProviderId): ProviderAdapter {
  return ADAPTERS[id];
}
