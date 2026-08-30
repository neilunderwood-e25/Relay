import { resolve } from 'node:path';
import type { OperationResult, TerminalReplay, TerminalSnapshot } from '../shared/contracts';

const BOOTSTRAP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const QUIET_WINDOW_MS = 1_500;

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

  const now = clock.now ?? Date.now;
  const wait = clock.wait ?? delay;
  const startedAt = now();
  let acceptedWorkspaceTrust = false;
  let trustSequence = 0;

  while (now() - startedAt < BOOTSTRAP_TIMEOUT_MS) {
    const terminal = terminals.list().find((candidate) => candidate.id === initial.id);
    if (!terminal || terminal.status === 'exited' || terminal.status === 'stopping') {
      throw new Error('Michael session exited before the CLI became ready.');
    }

    const replay = terminals.replay(initial.id).data;
    if (!acceptedWorkspaceTrust && isClaudeWorkspaceTrustPrompt(replay)) {
      trustSequence = terminal.lastSequence;
      const selection = await terminals.write(initial.id, '\x1b[B');
      if (!selection.ok) throw new Error(selection.error ?? 'Claude workspace trust could not be selected.');
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
      const confirmation = await terminals.write(initial.id, '\r');
      if (!confirmation.ok) throw new Error(confirmation.error ?? 'Claude workspace trust could not be confirmed.');
      acceptedWorkspaceTrust = true;
    }

    const quietFor = terminal.lastOutputAt > 0 ? now() - terminal.lastOutputAt : 0;
    const respondedAfterTrust = !acceptedWorkspaceTrust || terminal.lastSequence > trustSequence;
    if (terminal.status === 'running' && terminal.hasOutput && respondedAfterTrust && quietFor >= QUIET_WINDOW_MS) {
      return { terminal, acceptedWorkspaceTrust };
    }
    await wait(POLL_INTERVAL_MS);
  }

  throw new Error('Michael session did not become ready before the startup timeout.');
}

export function isClaudeWorkspaceTrustPrompt(output: string): boolean {
  return output.includes('Quick safety check:') && output.includes('Yes, I trust this folder');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
