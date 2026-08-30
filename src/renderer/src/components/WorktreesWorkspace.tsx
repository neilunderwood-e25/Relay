import { useCallback, useEffect, useState } from 'react';
import {
  Add01Icon,
  Alert02Icon,
  ChatGptIcon,
  ClaudeIcon,
  CodeFolderIcon,
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
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardHeader } from './ui/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Icon } from './ui/Icon';
import { Input } from './ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Tooltip } from './ui/app-tooltip';

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
  const [deleteTarget, setDeleteTarget] = useState<WorktreeSnapshot | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await window.relay.inspectRepository(cwd);
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
      await window.relay.createWorktree({
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
      const result = await window.relay.removeWorktree({
        id: worktree.id,
        repoPath: worktree.managed ? undefined : (repository?.mainRoot ?? cwd),
        force: worktree.dirty || worktree.ahead > 0
      });
      if (!result.ok) throw new Error(result.error ?? 'Worktree removal failed.');
      await refresh();
      setDeleteTarget(null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const openIde = async (): Promise<void> => {
    setBusy('ide');
    setError(null);
    try {
      const result = await window.relay.openIdeWorkspace(repository?.mainRoot ?? cwd);
      if (!result.ok) throw new Error(result.error ?? 'Could not open the IDE workspace.');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const worktreeCount = repository?.worktrees.filter((worktree) => !worktree.isMain).length ?? 0;

  return (
    <section className="worktrees-workspace">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <h1>Worktrees</h1>
          <Badge variant={worktreeCount > 0 ? 'default' : 'secondary'}>{worktreeCount}</Badge>
        </div>
        <div className="worker-actions">
          <Tooltip content="Open IDE">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open IDE workspace"
              disabled={loading || !repository?.isRepository || busy !== null}
              onClick={() => void openIde()}
            >
              <Icon icon={CodeFolderIcon} size={16} />
            </Button>
          </Tooltip>
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

      {error && <Alert variant="destructive" className="worktree-error"><Icon icon={Alert02Icon} size={15} /><AlertDescription>{error}</AlertDescription></Alert>}

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
              <Select
                value={baseBranch || undefined}
                onValueChange={(value) => { if (value) setBaseBranch(value); }}
                disabled={busy !== null || loading || !repository?.branches.length}
              >
                <SelectTrigger aria-label="Base branch">
                  <SelectValue placeholder="No commits">{baseBranch || 'No commits'}</SelectValue>
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
                onRemove={(worktree) => { setDeleteTarget(worktree); }}
              />
            ))}
          </div>

          <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busy) setDeleteTarget(null); }}>
            <DialogContent className="confirm-dialog">
              <DialogHeader>
                <DialogTitle>Delete worktree?</DialogTitle>
                <DialogDescription>{deleteWarning(deleteTarget)}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" disabled={busy !== null} onClick={() => setDeleteTarget(null)}>Cancel</Button>
                <Button variant="destructive" disabled={busy !== null} onClick={() => { if (deleteTarget) void remove(deleteTarget); }}>
                  {busy ? 'Deleting' : deleteTarget?.dirty ? 'Delete anyway' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
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
  onRemove: (worktree: WorktreeSnapshot) => void;
}): React.JSX.Element {
  const label = worktree.isMain ? 'Main checkout' : worktree.branch.replace(/^(?:relay|foundry)\//, '');
  const unavailable = worktree.status === 'missing' || worktree.status === 'locked';
  const removeLabel = worktree.status === 'missing'
    ? 'Forget worktree'
    : worktree.status === 'locked'
      ? 'Unlock first'
      : 'Delete worktree';

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
          {!worktree.isMain && (
            <Tooltip content={removeLabel}>
              <span className="disabled-tooltip-target">
                <Button
                  variant="ghost"
                  size="icon"
                  className="danger-icon-button"
                  aria-label="Remove worktree"
                  disabled={busy || worktree.status === 'locked'}
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
  if (worktree.status === 'missing') return <Badge variant="destructive">Missing</Badge>;
  if (worktree.status === 'locked') return <Badge variant="outline">Locked</Badge>;
  if (worktree.dirty) return <Badge variant="outline">Changes</Badge>;
  if (worktree.ahead > 0) return <Badge variant="outline">Ahead {worktree.ahead}</Badge>;
  return <Badge>Clean</Badge>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function deleteWarning(worktree: WorktreeSnapshot | null): string {
  if (!worktree) return '';
  if (worktree.status === 'missing') return 'Remove this missing worktree record?';
  if (worktree.dirty) return 'Uncommitted changes will be lost. The Git branch remains.';
  if (worktree.ahead > 0) return 'The folder will be removed. Its branch and commits remain.';
  return 'The worktree folder will be removed. Its Git branch remains.';
}
