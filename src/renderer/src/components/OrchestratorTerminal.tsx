import { useEffect, useMemo, useState } from 'react';
import {
  ChatGptIcon,
  ClaudeIcon,
  PlugZapIcon,
  RefreshIcon,
  SquareStopIcon,
  SquareTerminalIcon
} from '@hugeicons/core-free-icons';
import type { ProviderCapability, ProviderId, TerminalSnapshot } from '../../../shared/contracts';
import { DEFAULT_AGENT_NAMES } from '../../../shared/contracts';
import { useTerminalStore } from '../store/terminals';
import { TerminalView } from './TerminalView';
import { Button } from './ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Tooltip } from './ui/Tooltip';

export function OrchestratorTerminal({
  cwd,
  name,
  providers
}: {
  cwd: string;
  name: string;
  providers: ProviderCapability[];
}): React.JSX.Element {
  const terminals = useTerminalStore((state) => state.terminals);
  const upsert = useTerminalStore((state) => state.upsert);
  const remove = useTerminalStore((state) => state.remove);
  const markStopping = useTerminalStore((state) => state.markStopping);
  const [provider, setProvider] = useState<ProviderId>(() => preferredProvider(providers));
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const terminal = useMemo(() => terminals
    .filter((candidate) => candidate.role === 'orchestrator')
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null, [terminals]);

  useEffect(() => {
    if (!providers.some((candidate) => candidate.id === provider && candidate.available)) {
      setProvider(preferredProvider(providers));
    }
  }, [provider, providers]);

  const launch = async (): Promise<void> => {
    if (!cwd.trim()) return;
    setLaunching(true);
    setError(null);
    try {
      if (terminal?.status === 'exited') {
        const dismissed = await window.relay.dismissTerminal(terminal.id);
        if (dismissed.ok) remove(terminal.id);
      }
      const created = await window.relay.spawnTerminal({
        provider,
        role: 'orchestrator',
        cwd: cwd.trim(),
        name,
        cols: 120,
        rows: 32
      });
      upsert(created);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLaunching(false);
    }
  };

  const interrupt = async (snapshot: TerminalSnapshot): Promise<void> => {
    const result = await window.relay.interruptTerminal(snapshot.id);
    if (!result.ok) setError(result.error ?? 'Could not interrupt the terminal.');
  };

  const stop = async (snapshot: TerminalSnapshot): Promise<void> => {
    const force = snapshot.status === 'stopping';
    const result = await window.relay.stopTerminal(snapshot.id, force);
    if (!result.ok) setError(result.error ?? 'Could not stop the terminal.');
    else if (!force) markStopping(snapshot.id);
  };

  const providerCapability = providers.find((candidate) => candidate.id === provider);
  const available = providerCapability?.available === true;

  return (
    <Card className="terminal-card orchestrator-terminal-card">
      <CardHeader className="terminal-card-header">
        <div className="orchestrator-terminal-title">
          <span className="rehan-command-icon"><Icon icon={SquareTerminalIcon} size={16} /></span>
          <div>
            <strong>{name}</strong>
            <span className={`terminal-state ${terminal?.status ?? 'exited'}`} />
          </div>
        </div>

        <div className="terminal-actions">
          {!terminal || terminal.status === 'exited' ? (
            <Tooltip content="Start terminal">
              <Button size="sm" disabled={!available || launching || !cwd.trim()} onClick={() => void launch()}>
                <Icon icon={terminal ? RefreshIcon : SquareTerminalIcon} size={14} />
                {terminal ? 'Restart' : 'Start'}
              </Button>
            </Tooltip>
          ) : (
            <>
              <Tooltip content="Interrupt">
                <Button variant="ghost" size="icon" aria-label="Interrupt" onClick={() => void interrupt(terminal)}>
                  <Icon icon={PlugZapIcon} size={16} />
                </Button>
              </Tooltip>
              <Tooltip content={terminal.status === 'stopping' ? 'Force stop' : 'Stop terminal'}>
                <Button variant="ghost" size="icon" className="danger-icon-button" aria-label="Stop terminal" onClick={() => void stop(terminal)}>
                  <Icon icon={SquareStopIcon} size={16} />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </CardHeader>

      {error && <div className="orchestrator-terminal-error" role="alert">{error}</div>}

      <CardContent className="terminal-card-content">
        {terminal ? (
          <TerminalView key={terminal.id} terminal={terminal} />
        ) : (
          <div className="orchestrator-terminal-empty">
            <span className="empty-terminal-icon"><Icon icon={SquareTerminalIcon} size={26} /></span>
            <div className="orchestrator-provider-picker" aria-label="Terminal provider">
              {providers.map((candidate) => (
                <Tooltip key={candidate.id} content={candidate.id === 'claude' ? 'Claude CLI' : 'Codex CLI'}>
                  <Button
                    size="sm"
                    variant={provider === candidate.id ? 'secondary' : 'ghost'}
                    className={provider === candidate.id ? 'selected' : ''}
                    disabled={!candidate.available}
                    aria-pressed={provider === candidate.id}
                    onClick={() => setProvider(candidate.id)}
                  >
                    <Icon icon={candidate.id === 'claude' ? ClaudeIcon : ChatGptIcon} size={15} />
                    {DEFAULT_AGENT_NAMES[candidate.id]}
                  </Button>
                </Tooltip>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="terminal-statusbar">
        {terminal ? (
          <>
            <span className={`provider-name ${terminal.provider}`}>
              <Icon icon={terminal.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
              {DEFAULT_AGENT_NAMES[terminal.provider]}
            </span>
            <code title={terminal.cwd}>{terminal.cwd}</code>
            <span className="terminal-pid">PID {terminal.pid}</span>
          </>
        ) : (
          <span className="terminal-ready"><span className="online-dot" /> Ready</span>
        )}
      </CardFooter>
    </Card>
  );
}

function preferredProvider(providers: ProviderCapability[]): ProviderId {
  return providers.find((provider) => provider.id === 'claude' && provider.available)?.id
    ?? providers.find((provider) => provider.available)?.id
    ?? 'claude';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
