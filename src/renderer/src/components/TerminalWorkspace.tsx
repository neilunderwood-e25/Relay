import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChatGptIcon,
  ClaudeIcon,
  Delete02Icon,
  PlugZapIcon,
  RefreshCwIcon,
  SentIcon,
  SquareStopIcon,
  SquareTerminalIcon
} from '@hugeicons/core-free-icons';
import type { AgentSession, TerminalSnapshot } from '../../../shared/contracts';
import { DEFAULT_AGENT_NAMES } from '../../../shared/contracts';
import { useTerminalStore } from '../store/terminals';
import { AgentAvatar } from './AgentAvatar';
import { TerminalView } from './TerminalView';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Input } from './ui/Input';
import { Tooltip } from './ui/app-tooltip';

export function TerminalWorkspace(): React.JSX.Element {
  const allTerminals = useTerminalStore((state) => state.terminals);
  const terminals = useMemo(
    () => allTerminals.filter((terminal) => (terminal.role ?? 'worker') === 'worker'),
    [allTerminals]
  );
  const selectedId = useTerminalStore((state) => state.selectedId);
  const select = useTerminalStore((state) => state.select);
  const hydrate = useTerminalStore((state) => state.hydrate);
  const remove = useTerminalStore((state) => state.remove);
  const markStopping = useTerminalStore((state) => state.markStopping);
  const setError = useTerminalStore((state) => state.setError);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [followup, setFollowup] = useState('');
  const [pending, setPending] = useState<'send' | 'restart' | 'stop' | null>(null);

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const next = await window.relay.listAgentSessions();
      setSessions(next);
      setSelectedSessionId((current) => current && next.some(({ id }) => id === current)
        ? current
        : (next[0]?.id ?? null));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [setError]);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);
  useEffect(() => window.relay.onOrchestrationUpdate(() => { void refreshSessions(); }), [refreshSessions]);

  useEffect(() => {
    const selectedTerminal = allTerminals.find((terminal) => terminal.id === selectedId);
    if (!selectedTerminal) return;
    const matching = sessions.find((session) => session.terminalId === selectedId);
    setSelectedSessionId(matching?.id ?? null);
  }, [allTerminals, selectedId, sessions]);

  const selectedSession = sessions.find(({ id }) => id === selectedSessionId) ?? null;
  const selectedTerminal = selectedSession
    ? selectedSession.terminalId
      ? terminals.find(({ id }) => id === selectedSession.terminalId) ?? null
      : null
    : allTerminals.find(({ id }) => id === selectedId) ?? terminals[0] ?? null;
  const sessionTerminalIds = new Set(sessions.flatMap(({ terminalId }) => terminalId ? [terminalId] : []));
  const standalone = allTerminals.filter(({ id }) => !sessionTerminalIds.has(id));
  const selectedTerminalIsInteractive = selectedTerminal
    ? (selectedTerminal.role ?? 'worker') === 'worker' && (selectedTerminal.outputMode ?? 'terminal') === 'terminal'
    : false;
  const canRestart = Boolean(
    selectedSession &&
    ['stopped', 'resumable', 'failed'].includes(selectedSession.status) &&
    (!selectedTerminal || selectedTerminal.status === 'exited')
  );
  const canPrompt = Boolean(
    selectedSession?.status === 'idle' &&
    selectedTerminal &&
    selectedTerminal.status !== 'exited'
  );

  const chooseSession = (session: AgentSession): void => {
    setSelectedSessionId(session.id);
    if (session.terminalId) select(session.terminalId);
    setFollowup('');
  };

  const chooseTerminal = (terminal: TerminalSnapshot): void => {
    setSelectedSessionId(null);
    select(terminal.id);
  };

  const stopTerminal = async (terminal: TerminalSnapshot): Promise<void> => {
    const force = terminal.status === 'stopping';
    const result = await window.relay.stopTerminal(terminal.id, force);
    if (!result.ok) setError(result.error ?? 'Could not stop terminal.');
    else if (!force) markStopping(terminal.id);
  };

  const stopSession = async (session: AgentSession): Promise<void> => {
    setPending('stop');
    try {
      const result = await window.relay.stopAgentSession({ sessionId: session.id });
      if (!result.ok) throw new Error(result.error ?? 'Could not stop agent.');
      if (session.terminalId) markStopping(session.terminalId);
      await refreshSessions();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };

  const restartSession = async (session: AgentSession): Promise<void> => {
    setPending('restart');
    try {
      const restarted = await window.relay.restartAgentSession({ sessionId: session.id });
      const activeTerminals = await window.relay.listTerminals();
      hydrate(activeTerminals);
      setSessions((current) => current.map((candidate) => candidate.id === restarted.id ? restarted : candidate));
      setSelectedSessionId(restarted.id);
      if (restarted.terminalId) select(restarted.terminalId);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };

  const submitFollowup = async (): Promise<void> => {
    if (!selectedSession || !followup.trim() || !canPrompt) return;
    setPending('send');
    try {
      const updated = await window.relay.submitAgentSessionInput({
        sessionId: selectedSession.id,
        prompt: followup.trim()
      });
      setSessions((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setFollowup('');
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
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
    <div className="agent-console">
      <Card className="agent-session-rail">
        <CardHeader className="agent-session-rail-header">
          <strong>Agents</strong>
          <Badge variant="secondary">{sessions.length}</Badge>
        </CardHeader>
        <CardContent className="agent-session-list">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className="agent-session-item"
              data-active={session.id === selectedSession?.id}
              onClick={() => chooseSession(session)}
            >
              <AgentAvatar seed={session.avatarSeed} name={session.agentName} className="agent-session-avatar" />
              <span className="agent-session-copy">
                <strong>{session.agentName}</strong>
                <small>
                  <Icon icon={session.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
                  {sessionStatusLabel(session.status)}
                </small>
              </span>
              <span className={`agent-session-dot ${session.status}`} />
            </button>
          ))}
          {sessions.length === 0 && <span className="agent-session-none">No agents</span>}

          {standalone.length > 0 && (
            <div className="standalone-terminal-group">
              <span>Terminals</span>
              {standalone.map((terminal) => (
                <button
                  key={terminal.id}
                  type="button"
                  className="agent-session-item"
                  data-active={!selectedSession && terminal.id === selectedTerminal?.id}
                  onClick={() => chooseTerminal(terminal)}
                >
                  <span className="standalone-terminal-icon"><Icon icon={SquareTerminalIcon} size={15} /></span>
                  <span className="agent-session-copy">
                    <strong>{terminal.name}</strong>
                    <small>{statusLabel(terminal.status)}</small>
                  </span>
                  <span className={`terminal-state ${terminal.status}`} />
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="terminal-card">
        <CardHeader className="terminal-card-header agent-console-header">
          {selectedSession ? (
            <div className="agent-console-identity">
              <AgentAvatar seed={selectedSession.avatarSeed} name={selectedSession.agentName} className="terminal-agent-avatar" />
              <div>
                <strong>{selectedSession.agentName}</strong>
                <span>
                  <Icon icon={selectedSession.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
                  {DEFAULT_AGENT_NAMES[selectedSession.provider]}
                </span>
              </div>
              <Badge variant={selectedSession.status === 'idle' ? 'default' : 'secondary'}>
                {sessionStatusLabel(selectedSession.status)}
              </Badge>
            </div>
          ) : selectedTerminal ? (
            <div className="agent-console-identity">
              <span className="standalone-terminal-icon"><Icon icon={SquareTerminalIcon} size={15} /></span>
              <div>
                <strong>{selectedTerminal.name}</strong>
                <span>{selectedTerminalIsInteractive ? 'Terminal' : 'Read only'}</span>
              </div>
            </div>
          ) : (
            <span className="terminal-label"><Icon icon={SquareTerminalIcon} size={15} /> Console</span>
          )}

          {(selectedSession || selectedTerminal) && (
            <div className="terminal-actions">
              {selectedSession && canRestart && (
                <Tooltip content={sessionActionLabel(selectedSession.status)}>
                  <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void restartSession(selectedSession)}>
                    <Icon icon={RefreshCwIcon} size={15} /> {sessionActionLabel(selectedSession.status)}
                  </Button>
                </Tooltip>
              )}
              {selectedTerminal?.status !== 'exited' && selectedTerminalIsInteractive && (
                <>
                  <Tooltip content="Interrupt">
                    <Button variant="ghost" size="icon" aria-label="Interrupt" onClick={() => void interrupt(selectedTerminal!)}>
                      <Icon icon={PlugZapIcon} size={16} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Stop">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="danger-icon-button"
                      aria-label="Stop"
                      disabled={pending !== null || selectedSession?.status === 'stopping'}
                      onClick={() => selectedSession ? void stopSession(selectedSession) : void stopTerminal(selectedTerminal!)}
                    >
                      <Icon icon={SquareStopIcon} size={16} />
                    </Button>
                  </Tooltip>
                </>
              )}
              {!selectedSession && selectedTerminal?.status === 'exited' && selectedTerminalIsInteractive && (
                <Tooltip content="Dismiss">
                  <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={() => void dismiss(selectedTerminal)}>
                    <Icon icon={Delete02Icon} size={16} />
                  </Button>
                </Tooltip>
              )}
            </div>
          )}
        </CardHeader>

        {selectedSession?.error && selectedSession.status !== 'idle' && (
          <div className="agent-recovery-note" title={selectedSession.error} role="status">
            {selectedSession.error}
          </div>
        )}

        <CardContent className="terminal-card-content">
          {selectedTerminal ? (
            <TerminalView key={selectedTerminal.id} terminal={selectedTerminal} />
          ) : (
            <div className="terminal-empty-state">
              <div className="empty-terminal-icon"><Icon icon={SquareTerminalIcon} size={28} /></div>
              <span>{selectedSession ? 'Session stopped' : 'No session'}</span>
              {selectedSession && canRestart && (
                <Button variant="outline" size="sm" disabled={pending !== null} onClick={() => void restartSession(selectedSession)}>
                  <Icon icon={RefreshCwIcon} size={15} /> {sessionActionLabel(selectedSession.status)}
                </Button>
              )}
            </div>
          )}
        </CardContent>

        {selectedSession && (
          <form className="agent-followup" onSubmit={(event) => { event.preventDefault(); void submitFollowup(); }}>
            <Input
              key={selectedSession.id}
              value={followup}
              disabled={!canPrompt || pending !== null}
              aria-label="Agent follow-up"
              placeholder={canPrompt ? `Message ${selectedSession.agentName}` : sessionInputHint(selectedSession.status)}
              onChange={(event) => setFollowup(event.target.value)}
            />
            <Tooltip content="Send">
              <Button size="icon" type="submit" aria-label="Send follow-up" disabled={!canPrompt || !followup.trim() || pending !== null}>
                <Icon icon={SentIcon} size={16} />
              </Button>
            </Tooltip>
          </form>
        )}

        <CardFooter className="terminal-statusbar">
          {selectedTerminal ? (
            <>
              <span className={`provider-name ${selectedTerminal.provider}`}>
                <Icon icon={selectedTerminal.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
                {selectedTerminal.name}
              </span>
              {selectedSession?.branch && <code title={selectedSession.branch}>{selectedSession.branch}</code>}
              <code title={selectedTerminal.cwd}>{selectedTerminal.cwd}</code>
              <span className="terminal-pid">PID {selectedTerminal.pid}</span>
            </>
          ) : (
            <span className="terminal-ready">
              <span className="online-dot" />
              {selectedSession ? sessionStatusLabel(selectedSession.status) : 'Ready'}
            </span>
          )}
        </CardFooter>
      </Card>
    </div>
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

function sessionStatusLabel(status: AgentSession['status']): string {
  switch (status) {
    case 'starting': return 'Starting';
    case 'working': return 'Working';
    case 'idle': return 'Ready';
    case 'stopping': return 'Stopping';
    case 'stopped': return 'Stopped';
    case 'resumable': return 'Resume';
    case 'failed': return 'Error';
    case 'closed': return 'Closed';
  }
}

function sessionInputHint(status: AgentSession['status']): string {
  if (status === 'working' || status === 'starting') return 'Agent working';
  if (status === 'stopping') return 'Agent stopping';
  if (status === 'closed') return 'Worktree removed';
  if (status === 'idle') return 'Message agent';
  return 'Restart agent';
}

function sessionActionLabel(status: AgentSession['status']): string {
  return status === 'resumable' ? 'Resume' : 'Restart';
}
