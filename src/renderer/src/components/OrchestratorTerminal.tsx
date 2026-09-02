import { useState } from 'react';
import {
  PlugZapIcon,
  RefreshIcon,
  SquareStopIcon,
  SquareTerminalIcon
} from '@hugeicons/core-free-icons';
import type { ProviderCapability, ProviderId, TerminalSnapshot } from '../../../shared/contracts';
import { DEFAULT_AGENT_NAMES } from '../../../shared/contracts';
import { orchestratorModelLabel } from '../../../shared/orchestratorModels';
import { useTerminalStore } from '../store/terminals';
import { TerminalView } from './TerminalView';
import { Button } from './ui/Button';
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { providerIcon } from '../providerUi';
import { Tooltip } from './ui/app-tooltip';

export function OrchestratorTerminal({
  cwd,
  name,
  providers,
  orchestratorProvider,
  orchestratorModel,
  terminal
}: {
  cwd: string;
  name: string;
  providers: ProviderCapability[];
  orchestratorProvider: ProviderId;
  orchestratorModel: string | null;
  terminal: TerminalSnapshot | null;
}): React.JSX.Element {
  const upsert = useTerminalStore((state) => state.upsert);
  const remove = useTerminalStore((state) => state.remove);
  const markStopping = useTerminalStore((state) => state.markStopping);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async (): Promise<void> => {
    if (!cwd.trim()) return;
    setLaunching(true);
    setError(null);
    try {
      if (terminal?.status === 'exited') {
        const dismissed = await window.relay.dismissTerminal(terminal.id);
        if (dismissed.ok) remove(terminal.id);
      }
      const created = await window.relay.ensureOrchestratorSession();
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

  const providerCapability = providers.find((candidate) => candidate.id === orchestratorProvider);
  const available = providerCapability?.available === true;
  const modelLabel = orchestratorModelLabel(orchestratorProvider, orchestratorModel);

  return (
    <Card className="terminal-card orchestrator-terminal-card">
      <CardHeader className="terminal-card-header">
        <div className="orchestrator-terminal-title">
          <span className="orchestrator-command-icon"><Icon icon={SquareTerminalIcon} size={16} /></span>
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

      {error && <Alert variant="destructive" className="orchestrator-terminal-error"><AlertDescription>{error}</AlertDescription></Alert>}

      <CardContent className="terminal-card-content">
        {terminal ? (
          <TerminalView key={terminal.id} terminal={terminal} />
        ) : (
          <div className="orchestrator-terminal-empty">
            <span className="empty-terminal-icon"><Icon icon={SquareTerminalIcon} size={26} /></span>
            <div className="orchestrator-provider-summary">
              <span className={`provider-name ${orchestratorProvider}`}>
                <Icon icon={providerIcon(orchestratorProvider)} size={14} />
                {DEFAULT_AGENT_NAMES[orchestratorProvider]}
              </span>
              <span>{modelLabel}</span>
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="terminal-statusbar">
        {terminal ? (
          <>
            <span className={`provider-name ${terminal.provider}`}>
              <Icon icon={providerIcon(terminal.provider)} size={12} />
              {name}
            </span>
            <span className="terminal-provider-label">
              {DEFAULT_AGENT_NAMES[terminal.provider]} · {modelLabel}
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

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
