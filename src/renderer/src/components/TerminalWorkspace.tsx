import { useMemo } from 'react';
import {
  ChatGptIcon,
  ClaudeIcon,
  Delete02Icon,
  PlugZapIcon,
  SquareStopIcon,
  SquareTerminalIcon
} from '@hugeicons/core-free-icons';
import type { TerminalSnapshot } from '../../../shared/contracts';
import { DEFAULT_AGENT_NAMES } from '../../../shared/contracts';
import { useTerminalStore } from '../store/terminals';
import { AgentAvatar } from './AgentAvatar';
import { TerminalView } from './TerminalView';
import { Button } from './ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Tabs, TabsList, TabsTrigger } from './ui/Tabs';
import { Tooltip } from './ui/Tooltip';

export function TerminalWorkspace(): React.JSX.Element {
  const allTerminals = useTerminalStore((state) => state.terminals);
  const terminals = useMemo(
    () => allTerminals.filter((terminal) => terminal.role !== 'orchestrator'),
    [allTerminals]
  );
  const selectedId = useTerminalStore((state) => state.selectedId);
  const select = useTerminalStore((state) => state.select);
  const remove = useTerminalStore((state) => state.remove);
  const markStopping = useTerminalStore((state) => state.markStopping);
  const setError = useTerminalStore((state) => state.setError);
  const selected = terminals.find((terminal) => terminal.id === selectedId) ?? terminals[0] ?? null;

  const stop = async (terminal: TerminalSnapshot): Promise<void> => {
    const force = terminal.status === 'stopping';
    const result = await window.relay.stopTerminal(terminal.id, force);
    if (!result.ok) setError(result.error ?? 'Could not stop terminal.');
    else if (!force) markStopping(terminal.id);
  };

  const interrupt = async (terminal: TerminalSnapshot): Promise<void> => {
    const result = await window.relay.interruptTerminal(terminal.id);
    if (!result.ok) setError(result.error ?? 'Could not interrupt terminal.');
  };

  const dismiss = async (terminal: TerminalSnapshot): Promise<void> => {
    const result = await window.relay.dismissTerminal(terminal.id);
    if (result.ok) remove(terminal.id);
    else setError(result.error ?? 'Could not dismiss terminal.');
  };

  return (
    <Card className="terminal-card">
      <CardHeader className="terminal-card-header">
        <Tabs value={selected?.id ?? ''} onValueChange={select} className="terminal-tabs">
          <TabsList>
            {terminals.length === 0 ? (
              <span className="terminal-label"><Icon icon={SquareTerminalIcon} size={15} /> Terminal</span>
            ) : terminals.map((terminal) => (
              <TabsTrigger key={terminal.id} value={terminal.id} title={statusLabel(terminal.status)}>
                <AgentAvatar seed={terminal.avatarSeed ?? terminal.id} name={terminal.name} className="terminal-agent-avatar" />
                <Icon icon={terminal.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={13} />
                {terminal.name}
                <span className={`terminal-state ${terminal.status}`} />
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {selected && (
          <div className="terminal-actions">
            {selected.status !== 'exited' ? (
              <>
                <Tooltip content="Interrupt">
                  <Button variant="ghost" size="icon" aria-label="Interrupt" onClick={() => void interrupt(selected)}>
                    <Icon icon={PlugZapIcon} size={16} />
                  </Button>
                </Tooltip>
                <Tooltip content={selected.status === 'stopping' ? 'Force stop' : 'Stop'}>
                  <Button variant="ghost" size="icon" className="danger-icon-button" aria-label="Stop" onClick={() => void stop(selected)}>
                    <Icon icon={SquareStopIcon} size={16} />
                  </Button>
                </Tooltip>
              </>
            ) : (
              <Tooltip content="Dismiss">
                <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => void dismiss(selected)}>
                  <Icon icon={Delete02Icon} size={16} />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
      </CardHeader>

      <CardContent className="terminal-card-content">
        {selected ? (
          <TerminalView key={selected.id} terminal={selected} />
        ) : (
          <div className="terminal-empty-state">
            <div className="empty-terminal-icon"><Icon icon={SquareTerminalIcon} size={28} /></div>
            <span>No session</span>
          </div>
        )}
      </CardContent>

      <CardFooter className="terminal-statusbar">
        {selected ? (
          <>
            <span className={`provider-name ${selected.provider}`}>
              <Icon icon={selected.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
              {selected.name}
            </span>
            <span className="terminal-provider-label">{DEFAULT_AGENT_NAMES[selected.provider]}</span>
            <code title={selected.cwd}>{selected.cwd}</code>
            <span className="terminal-pid">PID {selected.pid}</span>
          </>
        ) : (
          <span className="terminal-ready"><span className="online-dot" /> Ready</span>
        )}
      </CardFooter>
    </Card>
  );
}

function statusLabel(status: TerminalSnapshot['status']): string {
  switch (status) {
    case 'starting': return 'Starting';
    case 'running': return 'Running';
    case 'stopping': return 'Stopping';
    case 'exited': return 'Exited';
  }
}
