import { useEffect, useState } from 'react';
import { Activity01Icon, SquareTerminalIcon } from '@hugeicons/core-free-icons';
import type { OrchestratorProjectionSnapshot } from '../../../shared/contracts';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Tooltip } from './ui/app-tooltip';

const EMPTY_PROJECTION: OrchestratorProjectionSnapshot = {
  terminalId: null,
  status: 'starting',
  updatedAt: 0,
  lastSequence: 0,
  lines: [],
  events: []
};

export function OrchestratorProjection({
  name,
  onOpenTerminal
}: {
  name: string;
  onOpenTerminal: (terminalId: string) => void;
}): React.JSX.Element {
  const [projection, setProjection] = useState<OrchestratorProjectionSnapshot>(EMPTY_PROJECTION);

  useEffect(() => {
    let cancelled = false;
    void window.relay.getOrchestratorProjection()
      .then((snapshot) => { if (!cancelled) setProjection(snapshot); })
      .catch(() => undefined);
    const unsubscribe = window.relay.onOrchestratorProjection((snapshot) => setProjection(snapshot));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const lines = projection.lines.slice(-4);
  const events = projection.events.slice(-3);
  const status = projectionStatusLabel(projection.status);

  return (
    <Card size="sm" className="orchestrator-live-card">
      <CardHeader className="orchestrator-live-header">
        <div className="orchestrator-live-title">
          <Icon icon={Activity01Icon} size={14} />
          <strong>{name} live</strong>
          <span className={`orchestrator-live-dot ${projection.status}`} />
        </div>
        <div className="orchestrator-live-actions">
          <Badge variant={projection.status === 'error' ? 'destructive' : 'secondary'}>{status}</Badge>
          <Tooltip content="Open terminal">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open terminal"
              disabled={!projection.terminalId}
              onClick={() => projection.terminalId && onOpenTerminal(projection.terminalId)}
            >
              <Icon icon={SquareTerminalIcon} size={13} />
            </Button>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent className="orchestrator-live-content">
        <div className="orchestrator-live-output" aria-live="polite" aria-label="Live orchestrator output">
          {lines.length > 0
            ? lines.map((line, index) => <span key={`${projection.lastSequence}-${index}`}>{line}</span>)
            : <span className="orchestrator-live-empty">Waiting for input</span>}
        </div>
        {events.length > 0 && (
          <div className="orchestrator-live-events" aria-label="Recent orchestrator activity">
            {events.map((event) => <span key={event.id} data-kind={event.kind}>{event.label}</span>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function projectionStatusLabel(status: OrchestratorProjectionSnapshot['status']): string {
  if (status === 'starting') return 'Starting';
  if (status === 'working') return 'Working';
  if (status === 'stopped') return 'Stopped';
  if (status === 'error') return 'Error';
  return 'Ready';
}
