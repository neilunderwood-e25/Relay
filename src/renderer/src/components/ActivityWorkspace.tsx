import { useCallback, useEffect, useState } from 'react';
import {
  Activity01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  GitBranchIcon,
  RefreshIcon,
  Robot01Icon,
  SquareTerminalIcon
} from '@hugeicons/core-free-icons';
import type { ActivityCategory, ActivityEvent } from '../../../shared/contracts';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Alert, AlertDescription } from './ui/alert';
import { Icon } from './ui/Icon';
import { Tooltip } from './ui/app-tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from './ui/dialog';

const FILTERS: Array<{ id: ActivityCategory; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'orchestration', label: 'Runs' },
  { id: 'worktree', label: 'Git' },
  { id: 'terminal', label: 'Terminals' },
  { id: 'system', label: 'System' }
];

export function ActivityWorkspace(): React.JSX.Element {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [category, setCategory] = useState<ActivityCategory>('all');
  const [hasMore, setHasMore] = useState(false);
  const [nextBeforeId, setNextBeforeId] = useState<number | undefined>();
  const [selected, setSelected] = useState<ActivityEvent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    setError(null);
    try {
      const page = await window.relay.listActivity({
        category,
        beforeId: append ? nextBeforeId : undefined,
        limit: 30
      });
      setEvents((current) => append ? [...current, ...page.events] : page.events);
      setHasMore(page.hasMore);
      setNextBeforeId(page.nextBeforeId);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [category, nextBeforeId]);

  useEffect(() => { void load(false); }, [category]);

  return (
    <section className="operations-workspace activity-workspace">
      <header className="dashboard-header operations-header">
        <div className="dashboard-title">
          <h1>Activity</h1>
          <Badge variant="secondary">{events.length}</Badge>
        </div>
        <Tooltip content="Refresh activity">
          <Button variant="ghost" size="icon" aria-label="Refresh activity" disabled={loading} onClick={() => void load(false)}>
            <Icon icon={RefreshIcon} size={16} />
          </Button>
        </Tooltip>
      </header>

      <div className="activity-filters" aria-label="Activity filter">
        {FILTERS.map((filter) => (
          <Button
            key={filter.id}
            size="sm"
            variant={category === filter.id ? 'secondary' : 'ghost'}
            aria-pressed={category === filter.id}
            onClick={() => setCategory(filter.id)}
          >
            {filter.label}
          </Button>
        ))}
      </div>

      {error && <Alert variant="destructive"><Icon icon={Alert02Icon} size={15} /><AlertDescription>{error}</AlertDescription></Alert>}

      <div className="activity-list" aria-busy={loading}>
        {events.map((event) => {
          const presentation = eventPresentation(event);
          return (
            <button key={event.id} className={`activity-row ${presentation.tone}`} onClick={() => setSelected(event)}>
              <span className="activity-row-icon"><Icon icon={presentation.icon} size={15} /></span>
              <span className="activity-row-copy">
                <strong>{presentation.title}</strong>
                <small>{presentation.detail}</small>
              </span>
              <time dateTime={new Date(event.occurredAt).toISOString()}>{relativeTime(event.occurredAt)}</time>
            </button>
          );
        })}
        {!loading && events.length === 0 && (
          <div className="operations-empty"><Icon icon={Activity01Icon} size={20} /><span>No activity</span></div>
        )}
      </div>

      {hasMore && (
        <Button className="activity-more" variant="ghost" size="sm" disabled={loading} onClick={() => void load(true)}>
          <Icon icon={ArrowDown01Icon} size={14} /> More
        </Button>
      )}

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="activity-dialog">
          <DialogHeader>
            <DialogTitle>{selected ? eventPresentation(selected).title : 'Activity'}</DialogTitle>
            <DialogDescription>{selected ? new Date(selected.occurredAt).toLocaleString() : ''}</DialogDescription>
          </DialogHeader>
          <code className="activity-event-type">{selected?.type}</code>
          <pre className="activity-payload">{selected ? JSON.stringify(selected.payload, null, 2) : ''}</pre>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function eventPresentation(event: ActivityEvent): {
  title: string;
  detail: string;
  tone: 'default' | 'success' | 'warning';
  icon: typeof Activity01Icon;
} {
  const type = event.type;
  const payload = event.payload;
  const detail = firstText(payload, ['name', 'branch', 'provider', 'status', 'decision'])
    ?? shortId(payload.runId ?? payload.taskId ?? payload.terminalId ?? payload.worktreeId)
    ?? type;
  if (type.startsWith('worktree.')) {
    return { title: eventTitle(type), detail, tone: type.includes('removed') ? 'warning' : 'default', icon: GitBranchIcon };
  }
  if (type.startsWith('terminal.')) {
    return { title: eventTitle(type), detail, tone: type.includes('finished') ? 'success' : 'default', icon: SquareTerminalIcon };
  }
  if (type.startsWith('orchestration.')) {
    const warning = /failed|conflict|stopping/.test(type);
    const success = /finished|integrated|reviewed|cleaned/.test(type);
    return { title: eventTitle(type), detail, tone: warning ? 'warning' : success ? 'success' : 'default', icon: Robot01Icon };
  }
  return { title: eventTitle(type), detail, tone: 'default', icon: Activity01Icon };
}

function eventTitle(type: string): string {
  const labels: Record<string, string> = {
    'app.started': 'Relay started',
    'app.stopping': 'Relay stopped',
    'app.workspace.configured': 'Workspace opened',
    'app.preferences.updated': 'Defaults updated',
    'app.orchestrator.renamed': 'Agent renamed',
    'app.recovery.completed': 'Recovery complete',
    'orchestration.created': 'Run started',
    'orchestration.stopping': 'Run stopping',
    'orchestration.integrated': 'Run integrated',
    'orchestration.cleaned': 'Worktrees cleaned',
    'orchestration.integration.conflict': 'Merge conflict',
    'orchestration.verification.started': 'Verification started',
    'orchestration.verification.finished': 'Verification finished',
    'orchestration.task.started': 'Agent started',
    'orchestration.task.finished': 'Agent finished',
    'orchestration.task.failed': 'Agent failed',
    'orchestration.task.retried': 'Task retried',
    'orchestration.task.reviewed': 'Task reviewed',
    'orchestration.task.integrated': 'Task integrated',
    'worktree.created': 'Worktree created',
    'worktree.removed': 'Worktree removed',
    'worktree.forgotten': 'Worktree forgotten',
    'worktree.integrated': 'Branch integrated',
    'terminal.started': 'Terminal started',
    'terminal.finished': 'Terminal finished'
  };
  return labels[type] ?? type.split('.').at(-1)!.replace(/(^|_)(\w)/g, (_, __, char: string) => ` ${char.toUpperCase()}`).trim();
}

function firstText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
  }
  return null;
}

function shortId(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 18) : null;
}

function relativeTime(timestamp: number): string {
  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(deltaSeconds) < 60) return formatter.format(deltaSeconds, 'second');
  const minutes = Math.round(deltaSeconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(hours / 24), 'day');
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
