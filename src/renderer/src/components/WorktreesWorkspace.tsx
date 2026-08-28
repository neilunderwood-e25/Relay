import { useCallback, useEffect, useState } from 'react';
import {
  Add01Icon,
  Alert02Icon,
  ChatGptIcon,
  ClaudeIcon,
  Delete02Icon,
  FolderOpenIcon,
  GitBranchIcon,
  RefreshIcon
} from '@hugeicons/core-free-icons';
import type {
  ProviderCapability,
  ProviderId,
  RepositorySnapshot,
  WorktreeSnapshot
} from '../../../shared/contracts';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Input } from './ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Tooltip } from './ui/Tooltip';

export function WorktreesWorkspace({ cwd, providers, onChooseDirectory, onLaunch }: {
  cwd: string;
  providers: ProviderCapability[];
  onChooseDirectory: () => void;
  onLaunch: (provider: ProviderId, cwd: string, label: string) => Promise<void>;
}): React.JSX.Element {
  const [repository, setRepository] = useState<RepositorySnapshot | null>(null);
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await window.foundry.inspectRepository(cwd);
      setRepository(snapshot);
      setBaseBranch((current) => snapshot.branches.includes(current)
        ? current
        : (snapshot.currentBranch && snapshot.branches.includes(snapshot.currentBranch)
            ? snapshot.currentBranch
            : (snapshot.branches[0] ?? '')));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async (): Promise<void> => {
    if (!name.trim() || !baseBranch) return;
    setBusy('create');
    setError(null);
    try {
      await window.foundry.createWorktree({
        repoPath: cwd,
        name: name.trim(),
        baseBranch: baseBranch || undefined
      });
      setName('');
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (worktree: WorktreeSnapshot): Promise<void> => {
    setBusy(worktree.id);
    setError(null);
    try {
      const result = await window.foundry.removeWorktree({ id: worktree.id });
      if (!result.ok) throw new Error(result.error ?? 'Worktree removal failed.');
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const managedCount = repository?.worktrees.filter((worktree) => worktree.managed).length ?? 0;

  return (
    <section className="worktrees-workspace">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <h1>Worktrees</h1>
          <Badge variant={managedCount > 0 ? 'success' : 'secondary'}>{managedCount}</Badge>
        </div>
        <div className="worker-actions">
          <Tooltip content="Choose project">
            <Button variant="ghost" size="icon" aria-label="Choose project" onClick={onChooseDirectory}>
              <Icon icon={FolderOpenIcon} size={16} />
            </Button>
          </Tooltip>
          <Tooltip content="Refresh worktrees">
            <Button variant="ghost" size="icon" aria-label="Refresh worktrees" disabled={loading} onClick={() => void refresh()}>
              <Icon icon={RefreshIcon} size={16} />
            </Button>
          </Tooltip>
        </div>
      </header>

      {error && <div className="worktree-error" role="alert"><Icon icon={Alert02Icon} size={15} />{error}</div>}

      {!loading && (!repository?.isRepository) ? (
        <Card className="worktree-empty-card">
          <CardContent className="worktree-empty-content">
            <div className="empty-terminal-icon"><Icon icon={GitBranchIcon} size={26} /></div>
            <strong>Git repository required</strong>
            <Button size="sm" variant="secondary" onClick={onChooseDirectory}>Choose project</Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card className="worktree-create-card">
            <CardContent className="worktree-create-content">
              <Input
                value={name}
                maxLength={48}
                placeholder="worktree-name"
                aria-label="Worktree name"
                disabled={busy !== null || loading}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void create(); }}
              />
              <Select value={baseBranch || undefined} onValueChange={setBaseBranch} disabled={busy !== null || loading || !repository?.branches.length}>
                <SelectTrigger aria-label="Base branch">
                  <SelectValue placeholder="No commits" />
                </SelectTrigger>
                <SelectContent>
                  {(repository?.branches ?? []).map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}
                </SelectContent>
              </Select>
              <Tooltip content={baseBranch ? 'Create worktree' : 'Commit required'}>
                <span className="disabled-tooltip-target">
                  <Button size="icon" aria-label="Create worktree" disabled={!name.trim() || !baseBranch || busy !== null || loading} onClick={() => void create()}>
                    <Icon icon={Add01Icon} size={17} />
                  </Button>
                </span>
              </Tooltip>
            </CardContent>
          </Card>

          <div className="worktree-grid">
            {(repository?.worktrees ?? []).map((worktree) => (
              <WorktreeCard
                key={worktree.id}
                worktree={worktree}
                providers={providers}
                busy={busy === worktree.id}
                onLaunch={onLaunch}
                onRemove={remove}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function WorktreeCard({ worktree, providers, busy, onLaunch, onRemove }: {
  worktree: WorktreeSnapshot;
  providers: ProviderCapability[];
  busy: boolean;
  onLaunch: (provider: ProviderId, cwd: string, label: string) => Promise<void>;
  onRemove: (worktree: WorktreeSnapshot) => Promise<void>;
}): React.JSX.Element {
  const label = worktree.isMain ? 'Main checkout' : worktree.branch.replace(/^foundry\//, '');
  const unavailable = worktree.status === 'missing' || worktree.status === 'locked';
  const removeLabel = worktree.status === 'missing'
    ? 'Forget worktree'
    : worktree.dirty
    ? 'Changes present'
    : worktree.ahead > 0
      ? 'Unmerged commits'
      : 'Remove worktree';

  return (
    <Card className={`worktree-card status-${worktree.status}`}>
      <CardHeader className="worktree-card-header">
        <div className="worktree-card-title">
          <span className="worktree-icon"><Icon icon={GitBranchIcon} size={16} /></span>
          <div>
            <strong>{label}</strong>
            <span>{worktree.branch}</span>
          </div>
        </div>
        <div className="worktree-badges">
          {worktree.isMain && <Badge variant="outline">Main</Badge>}
          {!worktree.managed && !worktree.isMain && <Badge variant="outline">External</Badge>}
          <StatusBadge worktree={worktree} />
        </div>
      </CardHeader>
      <CardContent className="worktree-card-content">
        <code title={worktree.path}>{worktree.path}</code>
        <div className="worktree-card-actions">
          <div className="worktree-launchers">
            {providers.map((provider) => (
              <Button
                key={provider.id}
                variant="secondary"
                size="sm"
                disabled={!provider.available || unavailable || busy}
                onClick={() => void onLaunch(provider.id, worktree.path, label)}
              >
                <Icon icon={provider.id === 'claude' ? ClaudeIcon : ChatGptIcon} size={14} />
                {provider.id === 'claude' ? 'Claude' : 'Codex'}
              </Button>
            ))}
          </div>
          {worktree.managed && (
            <Tooltip content={removeLabel}>
              <span className="disabled-tooltip-target">
                <Button
                  variant="ghost"
                  size="icon"
                  className="danger-icon-button"
                  aria-label="Remove worktree"
                  disabled={busy || worktree.dirty || worktree.ahead > 0 || worktree.status === 'locked'}
                  onClick={() => void onRemove(worktree)}
                >
                  <Icon icon={Delete02Icon} size={15} />
                </Button>
              </span>
            </Tooltip>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ worktree }: { worktree: WorktreeSnapshot }): React.JSX.Element {
  if (worktree.status === 'missing') return <Badge variant="warning">Missing</Badge>;
  if (worktree.status === 'locked') return <Badge variant="warning">Locked</Badge>;
  if (worktree.dirty) return <Badge variant="warning">Changes</Badge>;
  if (worktree.ahead > 0) return <Badge variant="warning">Ahead {worktree.ahead}</Badge>;
  return <Badge variant="success">Clean</Badge>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
