import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity01Icon,
  Alert02Icon,
  Folder01Icon,
  FolderGitIcon,
  RefreshIcon,
  Settings01Icon,
  ShieldCheckIcon
} from '@hugeicons/core-free-icons';
import type {
  AppSnapshot,
  OrchestrationStrategy,
  ProviderId,
  RelayPreferences,
  RuntimeDiagnostics
} from '../../../shared/contracts';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Alert, AlertDescription } from './ui/alert';
import { Icon } from './ui/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Separator } from './ui/Separator';
import { Tooltip } from './ui/app-tooltip';
import {
  providerIcon,
  providerLabel,
  providerReady,
  providerStatusDetail,
  providerStatusLabel,
  providerState
} from '../providerUi';

const AUTO_PROVIDER = '__auto__';

export function SettingsWorkspace({ snapshot, onPreferencesChange, onRefreshProviders }: {
  snapshot: AppSnapshot;
  onPreferencesChange: (preferences: RelayPreferences) => void;
  onRefreshProviders: () => Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState(snapshot.preferences);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [busy, setBusy] = useState<'save' | 'recovery' | 'refresh' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setDraft(snapshot.preferences), [snapshot.preferences]);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(snapshot.preferences), [draft, snapshot.preferences]);

  const refresh = useCallback(async () => {
    setBusy('refresh');
    setError(null);
    try {
      setDiagnostics(await window.relay.getDiagnostics());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshAll = async (): Promise<void> => {
    setBusy('refresh');
    setError(null);
    try {
      const [, nextDiagnostics] = await Promise.all([
        onRefreshProviders(),
        window.relay.getDiagnostics()
      ]);
      setDiagnostics(nextDiagnostics);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const preferences = await window.relay.updatePreferences(draft);
      setDraft(preferences);
      onPreferencesChange(preferences);
      setNotice('Defaults saved');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  const recover = async (): Promise<void> => {
    setBusy('recovery');
    setError(null);
    setNotice(null);
    try {
      const result = await window.relay.recoverOperations();
      if (!result.ok) throw new Error(result.error ?? 'Recovery failed.');
      const recovered = result.recoveredItems + result.replayedControls;
      setNotice(recovered > 0 ? `${recovered} items recovered` : 'Workspace healthy');
      setDiagnostics(await window.relay.getDiagnostics());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="operations-workspace settings-workspace">
      <header className="dashboard-header operations-header">
        <div className="dashboard-title"><h1>Settings</h1></div>
        <Tooltip content="Refresh health">
          <Button variant="ghost" size="icon" aria-label="Refresh health" disabled={busy !== null} onClick={() => void refreshAll()}>
            <Icon icon={RefreshIcon} size={16} />
          </Button>
        </Tooltip>
      </header>

      {(error || notice) && (
        <Alert variant={error ? 'destructive' : 'default'}>
          <Icon icon={error ? Alert02Icon : ShieldCheckIcon} size={15} />
          <AlertDescription>{error ?? notice}</AlertDescription>
        </Alert>
      )}

      <div className="settings-grid">
        <Card className="settings-card settings-defaults-card">
          <CardHeader className="settings-card-header">
            <span className="settings-card-icon"><Icon icon={Settings01Icon} size={16} /></span>
            <div><strong>Run defaults</strong><small>New objectives</small></div>
          </CardHeader>
          <CardContent className="settings-card-content">
            <SettingSelect label="Mode">
              <Select value={draft.defaultStrategy} onValueChange={(value) => setDraft((current) => ({ ...current, defaultStrategy: value as OrchestrationStrategy }))}>
                <SelectTrigger aria-label="Default run mode"><SelectValue>{strategyLabel(draft.defaultStrategy)}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value="balanced">Build</SelectItem>
                  <SelectItem value="parallel">Split</SelectItem>
                  <SelectItem value="audit">Audit</SelectItem>
                </SelectContent>
              </Select>
            </SettingSelect>
            <SettingSelect label="Agents">
              <Select value={String(draft.maxConcurrentAgents)} onValueChange={(value) => setDraft((current) => ({ ...current, maxConcurrentAgents: Number(value) }))}>
                <SelectTrigger aria-label="Agent concurrency"><SelectValue>{draft.maxConcurrentAgents}</SelectValue></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((count) => <SelectItem key={count} value={String(count)}>{count}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingSelect>
            <SettingSelect label="Verifier">
              <Select value={draft.verificationProvider ?? AUTO_PROVIDER} onValueChange={(value) => setDraft((current) => ({ ...current, verificationProvider: value === AUTO_PROVIDER ? null : value as ProviderId }))}>
                <SelectTrigger aria-label="Verification provider"><SelectValue>{providerLabel(draft.verificationProvider)}</SelectValue></SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_PROVIDER}>Automatic</SelectItem>
                  {snapshot.providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id} disabled={!providerReady(provider)}>
                      {providerLabel(provider.id)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingSelect>
            <Button className="settings-save" size="sm" disabled={!dirty || busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving' : 'Save'}
            </Button>
          </CardContent>
        </Card>

        <Card className="settings-card settings-workspace-card">
          <CardHeader className="settings-card-header">
            <span className="settings-card-icon"><Icon icon={FolderGitIcon} size={16} /></span>
            <div><strong>Workspace</strong><small>Current paths</small></div>
          </CardHeader>
          <CardContent className="settings-card-content settings-paths">
            <PathRow icon={Folder01Icon} label="Harness" value={snapshot.workspace.harnessHome ?? 'Not selected'} />
            <Separator />
            <PathRow icon={FolderGitIcon} label="Project" value={snapshot.workspace.projectPath ?? 'Not selected'} />
          </CardContent>
        </Card>

        <Card className="settings-card settings-runtime-card">
          <CardHeader className="settings-card-header">
            <span className="settings-card-icon"><Icon icon={Activity01Icon} size={16} /></span>
            <div><strong>Runtime</strong><small>{diagnostics ? formatUptime(diagnostics.uptimeMs) : 'Loading'}</small></div>
          </CardHeader>
          <CardContent className="settings-card-content">
            <div className="runtime-metrics">
              <Metric label="Terminals" value={diagnostics?.activeTerminals ?? 0} />
              <Metric label="Runs" value={diagnostics?.runningOrchestrations ?? 0} />
              <Metric label="Worktrees" value={diagnostics?.managedWorktrees ?? 0} />
              <Metric label="Events" value={diagnostics?.activityEvents ?? 0} />
            </div>
            <Separator />
            <div className="provider-health-list">
              {snapshot.providers.map((provider) => (
                <div key={provider.id}>
                  <span className={`provider-health-icon ${provider.id}`}><Icon icon={providerIcon(provider.id)} size={14} /></span>
                  <span className="provider-health-copy">
                    <strong>{providerLabel(provider.id)}</strong>
                    <small title={providerStatusDetail(provider)}>{providerStatusDetail(provider)}</small>
                  </span>
                  <Badge variant={providerState(provider) === 'error' ? 'destructive' : providerReady(provider) ? 'default' : 'secondary'}>
                    {providerStatusLabel(provider)}
                  </Badge>
                </div>
              ))}
            </div>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => void recover()}>
              <Icon icon={ShieldCheckIcon} size={14} /> {busy === 'recovery' ? 'Checking' : 'Run recovery'}
            </Button>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function SettingSelect({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <label className="settings-field"><span>{label}</span>{children}</label>;
}

function PathRow({ icon, label, value }: { icon: typeof Folder01Icon; label: string; value: string }): React.JSX.Element {
  return (
    <div className="settings-path-row">
      <Icon icon={icon} size={15} />
      <span><small>{label}</small><code title={value}>{value}</code></span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div><strong>{value}</strong><small>{label}</small></div>;
}

function formatUptime(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m uptime`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m uptime`;
}

function strategyLabel(strategy: OrchestrationStrategy): string {
  return strategy === 'parallel' ? 'Split' : strategy === 'audit' ? 'Audit' : 'Build';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
