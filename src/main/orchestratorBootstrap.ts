import { resolve } from 'node:path';
import type { OperationResult, TerminalReplay, TerminalSnapshot } from '../shared/contracts';

const BOOTSTRAP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const QUIET_WINDOW_MS = 1_500;
const TRUST_SELECTION_SETTLE_MS = 300;
const TRUST_PROMPT_SETTLE_MS = 500;

interface BootstrapTerminals {
  list(): TerminalSnapshot[];
  replay(id: string): TerminalReplay;
  write(id: string, data: string): Promise<OperationResult>;
}

interface BootstrapClock {
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface OrchestratorBootstrapResult {
  terminal: TerminalSnapshot;
  acceptedWorkspaceTrust: boolean;
}

/**
 * Wait for a newly spawned orchestrator CLI to reach its interactive prompt.
 * Claude may show a first-use trust dialog for Relay's own Hive directory. Relay
 * can safely accept that single, exact prompt because the directory was created
 * and constrained by Relay; all other interactive prompts remain user-owned.
 */
export async function prepareOrchestratorTerminal(
  initial: TerminalSnapshot,
  hiveAgentRoot: string,
  terminals: BootstrapTerminals,
  clock: BootstrapClock = {}
): Promise<OrchestratorBootstrapResult> {
  if (initial.role !== 'orchestrator' || initial.provider !== 'claude') {
    return { terminal: initial, acceptedWorkspaceTrust: false };
  }
  if (resolve(initial.cwd) !== resolve(hiveAgentRoot)) {
    throw new Error('Michael was not started inside Relay\'s Hive agent directory.');
  }

  return prepareClaudeTerminal(initial, terminals, clock, 'Michael');
}

/** Accept Claude's trust dialog only for the exact managed worktree assigned to this worker. */
export async function prepareWorkerTerminal(
  initial: TerminalSnapshot,
  managedWorktreePath: string,
  terminals: BootstrapTerminals,
  clock: BootstrapClock = {}
): Promise<OrchestratorBootstrapResult> {
  if (initial.role !== 'worker') {
    return { terminal: initial, acceptedWorkspaceTrust: false };
  }
  if (resolve(initial.cwd) !== resolve(managedWorktreePath)) {
    throw new Error('Worker was not started inside its managed Relay worktree.');
  }

  return prepareClaudeTerminal(initial, terminals, clock, 'Worker');
}

async function prepareClaudeTerminal(
  initial: TerminalSnapshot,
  terminals: BootstrapTerminals,
  clock: BootstrapClock,
  label: 'Michael' | 'Worker'
): Promise<OrchestratorBootstrapResult> {

  const now = clock.now ?? Date.now;
  const wait = clock.wait ?? delay;
  const startedAt = now();
  let acceptedWorkspaceTrust = false;
  let dismissedCodexUpdate = false;
  let trustSequence = 0;

  while (now() - startedAt < BOOTSTRAP_TIMEOUT_MS) {
    const terminal = terminals.list().find((candidate) => candidate.id === initial.id);
    if (!terminal || terminal.status === 'exited' || terminal.status === 'stopping') {
      throw new Error(`${label} session exited before the CLI became ready.`);
    }

    const replay = terminals.replay(initial.id).data;
    const claudeTrust = initial.provider === 'claude' && isClaudeWorkspaceTrustPrompt(replay);
    const codexTrust = initial.provider === 'codex' && isCodexWorkspaceTrustPrompt(replay);
    const codexUpdate = initial.provider === 'codex' && isCodexUpdatePrompt(replay);
    const quietFor = terminal.lastOutputAt > 0 ? now() - terminal.lastOutputAt : 0;
    if (!dismissedCodexUpdate && codexUpdate) {
      if (quietFor < TRUST_PROMPT_SETTLE_MS) {
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      const updateSequence = terminal.lastSequence;
      const selection = await terminals.write(initial.id, '\x1b[B');
      if (!selection.ok) throw new Error(selection.error ?? 'Codex update prompt could not be skipped.');
      await wait(TRUST_SELECTION_SETTLE_MS);
      const selected = terminals.list().find((candidate) => candidate.id === initial.id);
      if (!selected || selected.status === 'exited' || selected.lastSequence <= updateSequence) {
        throw new Error('Codex update selector did not respond.');
      }
      trustSequence = selected.lastSequence;
      const confirmation = await terminals.write(initial.id, '\r');
      if (!confirmation.ok) throw new Error(confirmation.error ?? 'Codex update prompt could not be skipped.');
      dismissedCodexUpdate = true;
      await wait(POLL_INTERVAL_MS);
      continue;
    }
    if (!acceptedWorkspaceTrust && (claudeTrust || codexTrust)) {
      if (quietFor < TRUST_PROMPT_SETTLE_MS) {
        await wait(POLL_INTERVAL_MS);
        continue;
      }
      trustSequence = terminal.lastSequence;
      if (claudeTrust) {
        const selection = await terminals.write(initial.id, '\x1b[B');
        if (!selection.ok) throw new Error(selection.error ?? 'Claude workspace trust could not be selected.');
        await wait(TRUST_SELECTION_SETTLE_MS);
        const selectionDeadline = now() + 2_000;
        let selected = terminals.list().find((candidate) => candidate.id === initial.id);
        while (selected && selected.status !== 'exited' && selected.lastSequence <= trustSequence && now() < selectionDeadline) {
          await wait(POLL_INTERVAL_MS);
          selected = terminals.list().find((candidate) => candidate.id === initial.id);
        }
        if (!selected || selected.status === 'exited' || selected.lastSequence <= trustSequence) {
          throw new Error('Claude workspace trust selector did not respond.');
        }
        trustSequence = selected.lastSequence;
      }
      const confirmation = await terminals.write(initial.id, '\r');
      if (!confirmation.ok) throw new Error(confirmation.error ?? `${initial.provider} workspace trust could not be confirmed.`);
      acceptedWorkspaceTrust = true;
    }

    const respondedAfterTrust = trustSequence === 0 || terminal.lastSequence > trustSequence;
    if (terminal.status === 'running' && terminal.hasOutput && respondedAfterTrust && quietFor >= QUIET_WINDOW_MS) {
      return { terminal, acceptedWorkspaceTrust };
    }
    await wait(POLL_INTERVAL_MS);
  }

  throw new Error(`${label} session did not become ready before the startup timeout.`);
}

export function isClaudeWorkspaceTrustPrompt(output: string): boolean {
  const compact = compactTerminalText(output);
  return compact.includes('quicksafetycheck:') && compact.includes('yes,itrustthisfolder');
}

export function isCodexWorkspaceTrustPrompt(output: string): boolean {
  const compact = compactTerminalText(output);
  return compact.includes('doyoutrustthecontentsofthisdirectory?') && compact.includes('yes,continue');
}

export function isCodexUpdatePrompt(output: string): boolean {
  const compact = compactTerminalText(output);
  return compact.includes('github.com/openai/codex/releases/latest')
    && compact.includes('updatenow')
    && compact.includes('skip');
}

function compactTerminalText(output: string): string {
  return output
    .replace(/\x1B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\x1B\\))/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
