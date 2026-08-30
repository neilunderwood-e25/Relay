import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity01Icon,
  Alert02Icon,
  Audit01Icon,
  Cancel01Icon,
  ChatGptIcon,
  CheckmarkCircle02Icon,
  CleanIcon,
  ClaudeIcon,
  Edit02Icon,
  GitBranchIcon,
  GitMergeIcon,
  FileViewIcon,
  Layers01Icon,
  PlayIcon,
  RefreshIcon,
  RepeatIcon,
  Robot01Icon,
  SquareStopIcon,
  SquareTerminalIcon,
  ShieldCheckIcon,
  Task01Icon,
  Tick02Icon,
  WorkflowIcon
} from '@hugeicons/core-free-icons';
import {
  type AgentProfile,
  type OrchestrationSnapshot,
  type OrchestrationStrategy,
  type OrchestrationTask,
  type OrchestrationTemplate,
  type ProviderCapability,
  type ProviderId,
  type RelayPreferences,
  type RepositorySnapshot,
  type TerminalSnapshot,
  type TaskDiffSnapshot
} from '../../../shared/contracts';
import { personNameForSeed } from '../../../shared/agentIdentity';
import { planObjective, planObjectiveForAgents } from '../../../shared/orchestration';
import { AgentAvatar } from './AgentAvatar';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Input } from './ui/Input';
import { Tooltip } from './ui/app-tooltip';
import { RichTextEditor } from './RichTextEditor';
import { OrchestratorTerminal } from './OrchestratorTerminal';
import { OrchestratorProjection } from './OrchestratorProjection';
import { Tabs, TabsList, TabsTrigger } from './ui/Tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';

const STRATEGIES: Array<{
  id: OrchestrationStrategy;
  label: string;
  tooltip: string;
  icon: typeof WorkflowIcon;
}> = [
  {
    id: 'balanced',
    label: 'Build',
    tooltip: 'Assign an implementation owner and an independent reviewer',
    icon: WorkflowIcon
  },
  {
    id: 'parallel',
    label: 'Split',
    tooltip: 'Turn separate instructions into parallel workstreams',
    icon: Layers01Icon
  },
  {
    id: 'audit',
    label: 'Audit',
    tooltip: 'Ask each worker for an independent, evidence-backed investigation',
    icon: Audit01Icon
  }
];

export function OrchestratorWorkspace({
  cwd,
  providers,
  orchestratorName,
  orchestratorProvider,
  orchestratorModel,
  orchestratorTerminal,
  preferences,
  profiles,
  templates,
  onRenameOrchestrator,
  onChooseDirectory,
  onOpenTerminal
}: {
  cwd: string;
  providers: ProviderCapability[];
  orchestratorName: string;
  orchestratorProvider: ProviderId;
  orchestratorModel: string | null;
  orchestratorTerminal: TerminalSnapshot | null;
  preferences: RelayPreferences;
  profiles: AgentProfile[];
  templates: OrchestrationTemplate[];
  onRenameOrchestrator: (name: string) => Promise<boolean>;
  onChooseDirectory: () => void;
  onOpenTerminal: (terminalId: string) => void;
}): React.JSX.Element {
  const [repository, setRepository] = useState<RepositorySnapshot | null>(null);
  const [runs, setRuns] = useState<OrchestrationSnapshot[]>([]);
  const [objective, setObjective] = useState('');
  const [strategy, setStrategy] = useState<OrchestrationStrategy>(preferences.defaultStrategy);
  const [selectedProviders, setSelectedProviders] = useState<ProviderId[]>([]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<string[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('__none__');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(orchestratorName);
  const [savingName, setSavingName] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<'monitor' | 'terminal'>('monitor');
  const submissionRef = useRef(false);

  useEffect(() => {
    if (!editingName) setNameDraft(orchestratorName);
  }, [editingName, orchestratorName]);

  useEffect(() => setStrategy(preferences.defaultStrategy), [preferences.defaultStrategy]);

  const availableProviders = useMemo(
    () => providers.filter((provider) => provider.available).map((provider) => provider.id),
    [providers]
  );
  const availableProfiles = useMemo(
    () => profiles.filter((profile) => profile.enabled && availableProviders.includes(profile.provider)),
    [profiles, availableProviders]
  );

  useEffect(() => {
    setSelectedProviders((current) => {
      const valid = current.filter((provider) => availableProviders.includes(provider));
      return valid.length > 0 || selectedProfileIds.length > 0 ? valid : availableProviders;
    });
  }, [availableProviders.join('|'), selectedProfileIds.length]);

  useEffect(() => {
    setSelectedProfileIds((current) => current.filter((id) => availableProfiles.some((profile) => profile.id === id)));
  }, [availableProfiles]);

  useEffect(() => {
    if (selectedTemplateId !== '__none__' && !templates.some(({ id }) => id === selectedTemplateId)) {
      setSelectedTemplateId('__none__');
    }
  }, [selectedTemplateId, templates]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const repo = await window.relay.inspectRepository(cwd);
      const nextRuns = repo.mainRoot ? await window.relay.listOrchestrations(repo.mainRoot) : [];
      setRepository(repo);
      setRuns(nextRuns);
      setSelectedRunId((current) => current && nextRuns.some(({ run }) => run.id === current)
        ? current
        : nextRuns[0]?.run.id ?? null);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => window.relay.onOrchestrationUpdate((snapshot) => {
    setRuns((current) => {
      if (repository?.mainRoot && snapshot.run.repoRoot !== repository.mainRoot) return current;
      const exists = current.some((candidate) => candidate.run.id === snapshot.run.id);
      return exists
        ? current.map((candidate) => candidate.run.id === snapshot.run.id ? snapshot : candidate)
        : [snapshot, ...current];
    });
  }), [repository?.mainRoot]);

  const selectedProfiles = availableProfiles.filter((profile) => selectedProfileIds.includes(profile.id));
  const workerCount = selectedProfiles.length > 0 ? selectedProfiles.length : selectedProviders.length;
  const preview = useMemo(() => {
    if (!objective.trim()) return [];
    return selectedProfiles.length > 0
      ? planObjectiveForAgents(objective.trim(), selectedProfiles.map((profile) => ({
          provider: profile.provider,
          profileId: profile.id,
          name: profile.name,
          avatarSeed: profile.avatarSeed,
          model: profile.model,
          instructions: profile.instructions
        })), strategy)
      : planObjective(objective.trim(), selectedProviders, strategy);
  }, [objective, selectedProfiles, selectedProviders, strategy]);
  const selectedRun = runs.find(({ run }) => run.id === selectedRunId) ?? runs[0] ?? null;
  const activeCount = runs.filter(({ run }) => ['planning', 'queued', 'running', 'summarizing', 'stopping'].includes(run.status)).length;

  const toggleProvider = (provider: ProviderId): void => {
    if (!availableProviders.includes(provider)) return;
    setSelectedTemplateId('__none__');
    setSelectedProfileIds([]);
    setSelectedProviders((current) => current.includes(provider)
      ? current.length === 1 ? current : current.filter((candidate) => candidate !== provider)
      : [...current, provider]);
  };

  const toggleProfile = (profileId: string): void => {
    setSelectedTemplateId('__none__');
    setSelectedProviders([]);
    setSelectedProfileIds((current) => current.includes(profileId)
      ? current.filter((id) => id !== profileId)
      : [...current, profileId].slice(0, 4));
  };

  const applyTemplate = (templateId: string): void => {
    setSelectedTemplateId(templateId);
    const template = templates.find(({ id }) => id === templateId);
    if (!template) return;
    setObjective(template.objective);
    setStrategy(template.strategy);
    const profileIds = template.profileIds.filter((id) => availableProfiles.some((profile) => profile.id === id));
    if (profileIds.length > 0) {
      setSelectedProfilesOnly(profileIds);
    } else {
      setSelectedProfileIds([]);
      setSelectedProviders(availableProviders);
    }
  };

  const chooseStrategy = (next: OrchestrationStrategy): void => {
    setSelectedTemplateId('__none__');
    setStrategy(next);
  };

  const setSelectedProfilesOnly = (profileIds: string[]): void => {
    setSelectedProviders([]);
    setSelectedProfileIds(profileIds.slice(0, 4));
  };

  const start = async (): Promise<void> => {
    if (!objective.trim() || workerCount === 0 || submissionRef.current) return;
    submissionRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const routedProviders = selectedProfiles.length > 0
        ? [...new Set(selectedProfiles.map((profile) => profile.provider))]
        : selectedProviders;
      await window.relay.submitOrchestratorInput({
        text: objective.trim(),
        strategy,
        providers: routedProviders,
        profileIds: selectedProfileIds,
        templateId: selectedTemplateId === '__none__' ? undefined : selectedTemplateId,
        concurrency: Math.min(
          templates.find(({ id }) => id === selectedTemplateId)?.concurrency ?? preferences.maxConcurrentAgents,
          workerCount
        )
      });
      setObjective('');
      setSelectedTemplateId('__none__');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      submissionRef.current = false;
      setBusy(false);
    }
  };

  const stop = async (runId: string): Promise<void> => {
    setError(null);
    const result = await window.relay.stopOrchestration(runId);
    if (!result.ok) setError(result.error ?? 'Could not stop this run.');
  };

  const replan = async (snapshot: OrchestrationSnapshot): Promise<void> => {
    if (submissionRef.current) return;
    submissionRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const created = await window.relay.replanOrchestration({ runId: snapshot.run.id });
      setRuns((current) => [created, ...current.filter((candidate) => candidate.run.id !== created.run.id)]);
      setSelectedRunId(created.run.id);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      submissionRef.current = false;
      setBusy(false);
    }
  };

  const retry = async (taskId: string): Promise<void> => {
    setError(null);
    const result = await window.relay.retryOrchestrationTask({ taskId });
    if (!result.ok) setError(result.error ?? 'Could not retry this task.');
  };

  const saveName = async (): Promise<void> => {
    const name = nameDraft.trim();
    if (!name || name === orchestratorName) {
      setEditingName(false);
      setNameDraft(orchestratorName);
      return;
    }
    setSavingName(true);
    if (await onRenameOrchestrator(name)) setEditingName(false);
    else setError('Could not rename the orchestrator.');
    setSavingName(false);
  };

  const replaceRun = useCallback((snapshot: OrchestrationSnapshot): void => {
    setRuns((current) => current.map((candidate) => candidate.run.id === snapshot.run.id ? snapshot : candidate));
  }, []);

  return (
    <section className="orchestrator-workspace">
      <header className="dashboard-header">
        <div className="dashboard-title">
          <AgentAvatar seed="relay-orchestrator" name={orchestratorName} className="orchestrator-heading-avatar" />
          {editingName ? (
            <div className="orchestrator-name-editor">
              <Input
                autoFocus
                value={nameDraft}
                maxLength={32}
                aria-label="Orchestrator name"
                disabled={savingName}
                onChange={(event) => setNameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveName();
                  if (event.key === 'Escape') setEditingName(false);
                }}
              />
              <Tooltip content="Save name">
                <Button variant="ghost" size="icon" aria-label="Save name" disabled={savingName || !nameDraft.trim()} onClick={() => void saveName()}>
                  <Icon icon={Tick02Icon} size={15} />
                </Button>
              </Tooltip>
              <Tooltip content="Cancel edit">
                <Button variant="ghost" size="icon" aria-label="Cancel edit" disabled={savingName} onClick={() => setEditingName(false)}>
                  <Icon icon={Cancel01Icon} size={15} />
                </Button>
              </Tooltip>
            </div>
          ) : (
            <>
              <h1>{orchestratorName}</h1>
              <Tooltip content="Rename agent">
                <Button className="orchestrator-rename" variant="ghost" size="icon" aria-label="Rename agent" onClick={() => setEditingName(true)}>
                  <Icon icon={Edit02Icon} size={14} />
                </Button>
              </Tooltip>
            </>
          )}
          {activeCount > 0 && <Badge>{activeCount} active</Badge>}
          <Tooltip content={sessionStatusLabel(orchestratorTerminal)}>
            <span
              className={`orchestrator-session-indicator ${orchestratorTerminal?.status ?? 'starting'}`}
              aria-label={`${orchestratorName} session ${orchestratorTerminal?.status ?? 'starting'}`}
            />
          </Tooltip>
        </div>
        <div className="orchestrator-header-controls">
          <Tabs value={workspaceMode} onValueChange={(value) => setWorkspaceMode(value as 'monitor' | 'terminal')}>
            <TabsList className="orchestrator-mode-switch" aria-label="Orchestrator view">
              <Tooltip content="Monitor view">
                <TabsTrigger value="monitor"><Icon icon={Activity01Icon} size={14} />Monitor</TabsTrigger>
              </Tooltip>
              <Tooltip content="Terminal mode">
                <TabsTrigger value="terminal"><Icon icon={SquareTerminalIcon} size={14} />Terminal</TabsTrigger>
              </Tooltip>
            </TabsList>
          </Tabs>
          {workspaceMode === 'monitor' && (
            <Tooltip content="Refresh runs">
              <Button variant="ghost" size="icon" aria-label="Refresh runs" disabled={loading} onClick={() => void refresh()}>
                <Icon icon={RefreshIcon} size={16} />
              </Button>
            </Tooltip>
          )}
        </div>
      </header>

      {error && <Alert variant="destructive" className="worktree-error"><Icon icon={Alert02Icon} size={15} /><AlertDescription>{error}</AlertDescription></Alert>}

      {workspaceMode === 'terminal' ? (
        <div className="orchestrator-terminal-stack">
          <Card className="orchestrator-command-card orchestrator-terminal-composer">
            <CardContent className="orchestrator-command-content">
              <RichTextEditor
                value={objective}
                disabled={busy || loading}
                onChange={setObjective}
                onSubmit={() => void start()}
              />
              <div className="orchestrator-terminal-send">
                <Tooltip content="Send input">
                  <span className="disabled-tooltip-target">
                    <Button
                      className="orchestrator-run-button"
                      aria-label="Send input"
                      disabled={!objective.trim() || busy || loading || workerCount === 0}
                      onClick={() => void start()}
                    >
                      <Icon icon={PlayIcon} size={14} /> Send
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </CardContent>
          </Card>
          <OrchestratorTerminal
            cwd={cwd}
            name={orchestratorName}
            providers={providers}
            orchestratorProvider={orchestratorProvider}
            orchestratorModel={orchestratorModel}
            terminal={orchestratorTerminal}
          />
        </div>
      ) : !loading && !repository?.isRepository ? (
        <Card className="worktree-empty-card">
          <CardContent className="worktree-empty-content">
            <span className="orchestrator-command-icon"><Icon icon={Robot01Icon} size={24} /></span>
            <strong>Git repository required</strong>
            <Button size="sm" variant="secondary" onClick={onChooseDirectory}>Choose project</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="orchestrator-command-center">
          <div className="orchestrator-main-column">
            <Card className="orchestrator-command-card">
              <CardContent className="orchestrator-command-content">
                <div className="orchestrator-objective-row">
                  <RichTextEditor
                    value={objective}
                    disabled={busy || loading}
                    onChange={setObjective}
                    onSubmit={() => void start()}
                  />
                </div>

                <div className="orchestrator-command-options">
                  <div className="orchestrator-command-settings">
                    {templates.length > 0 && (
                      <Select value={selectedTemplateId} onValueChange={(value) => applyTemplate(value ?? '__none__')}>
                        <SelectTrigger size="sm" className="orchestrator-template-select" aria-label="Run template">
                          <SelectValue>{templates.find(({ id }) => id === selectedTemplateId)?.name ?? 'Template'}</SelectValue>
                        </SelectTrigger>
                        <SelectContent align="start">
                          <SelectItem value="__none__">No template</SelectItem>
                          {templates.map((template) => <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    <div className="orchestrator-strategy-switch" aria-label="Run mode">
                      {STRATEGIES.map((option) => {
                        const selected = strategy === option.id;
                        return (
                          <Tooltip key={option.id} content={option.tooltip}>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              data-state={selected ? 'on' : 'off'}
                              className={selected ? 'selected' : ''}
                              aria-pressed={selected}
                              style={selected ? {
                                backgroundColor: 'var(--primary)',
                                borderColor: 'var(--primary)',
                                color: 'var(--primary-foreground)'
                              } : undefined}
                              onClick={() => chooseStrategy(option.id)}
                            >
                              <Icon icon={option.icon} size={13} /> {option.label}
                            </Button>
                          </Tooltip>
                        );
                      })}
                    </div>
                    <div className="orchestrator-provider-switch" aria-label="Workers">
                      {providers.map((provider) => {
                        const selected = selectedProviders.includes(provider.id);
                        return (
                          <Tooltip key={provider.id} content={provider.id === 'claude' ? 'Claude CLI' : 'Codex CLI'}>
                            <Button
                              type="button"
                              size="icon"
                              variant={selected ? 'secondary' : 'ghost'}
                              className={`provider-toggle ${provider.id} ${selected ? 'selected' : ''}`}
                              aria-label={provider.id === 'claude' ? 'Claude CLI' : 'Codex CLI'}
                              aria-pressed={selected}
                              disabled={!provider.available}
                              onClick={() => toggleProvider(provider.id)}
                            >
                              <Icon icon={provider.id === 'claude' ? ClaudeIcon : ChatGptIcon} size={14} />
                            </Button>
                          </Tooltip>
                        );
                      })}
                    </div>
                    {availableProfiles.length > 0 && (
                      <div className="orchestrator-profile-switch" aria-label="Agent profiles">
                        {availableProfiles.map((profile) => {
                          const selected = selectedProfileIds.includes(profile.id);
                          return (
                            <Tooltip key={profile.id} content={profile.name.split(/\s+/).slice(0, 2).join(' ')}>
                              <button
                                type="button"
                                className={`profile-toggle ${selected ? 'selected' : ''}`}
                                aria-label={profile.name}
                                aria-pressed={selected}
                                onClick={() => toggleProfile(profile.id)}
                              >
                                <AgentAvatar seed={profile.avatarSeed} name={profile.name} />
                              </button>
                            </Tooltip>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <Tooltip content="Send input">
                    <span className="disabled-tooltip-target">
                      <Button
                        className="orchestrator-run-button"
                        aria-label="Send input"
                        disabled={!objective.trim() || busy || loading || workerCount === 0}
                        onClick={() => void start()}
                      >
                        <Icon icon={PlayIcon} size={14} /> Send
                      </Button>
                    </span>
                  </Tooltip>
                </div>

                {preview.length > 0 && (
                  <div className="orchestrator-plan-preview" aria-label="Task plan">
                    {preview.map((task) => (
                      <div key={`${task.profileId ?? task.provider}-${task.title}`} className="orchestrator-plan-item">
                        {task.avatarSeed && task.agentName && (
                          <AgentAvatar seed={task.avatarSeed} name={task.agentName} className="plan-agent-avatar" />
                        )}
                        <span className={`orchestrator-task-provider ${task.provider}`}>
                          <Icon icon={task.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={12} />
                        </span>
                        <div><span>{task.agentName ?? roleLabel(task.role)}</span><strong>{task.title}</strong></div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <OrchestratorProjection name={orchestratorName} onOpenTerminal={onOpenTerminal} />

            {selectedRun ? (
              <MissionCard
                snapshot={selectedRun}
                orchestratorName={orchestratorName}
                onStop={stop}
                onReplan={replan}
                busy={busy}
                onRetry={retry}
                onOpenTerminal={onOpenTerminal}
                onSnapshot={replaceRun}
                onError={setError}
                verificationProvider={preferences.verificationProvider}
              />
            ) : (
              <Card className="orchestrator-ready-card">
                <CardContent><span className="online-dot" />Ready for work</CardContent>
              </Card>
            )}
          </div>

          <aside className="orchestrator-history" aria-label="Run history">
            <div className="orchestrator-history-title"><span>Runs</span><Badge variant="secondary">{runs.length}</Badge></div>
            <div className="orchestrator-history-list">
              {runs.map((snapshot) => (
                <button
                  key={snapshot.run.id}
                  className={`orchestrator-history-row ${selectedRun?.run.id === snapshot.run.id ? 'selected' : ''}`}
                  onClick={() => setSelectedRunId(snapshot.run.id)}
                >
                  <span className={`history-state ${snapshot.run.status}`} />
                  <span>{snapshot.run.objective}</span>
                  <small>{strategyLabel(snapshot.run.strategy)}</small>
                </button>
              ))}
              {runs.length === 0 && <span className="orchestrator-history-empty">No runs</span>}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}

function MissionCard({ snapshot, orchestratorName, onStop, onReplan, onRetry, onOpenTerminal, onSnapshot, onError, verificationProvider, busy }: {
  snapshot: OrchestrationSnapshot;
  orchestratorName: string;
  onStop: (runId: string) => Promise<void>;
  onReplan: (snapshot: OrchestrationSnapshot) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  onOpenTerminal: (terminalId: string) => void;
  onSnapshot: (snapshot: OrchestrationSnapshot) => void;
  onError: (message: string | null) => void;
  verificationProvider: ProviderId | null;
  busy: boolean;
}): React.JSX.Element {
  const { run, tasks } = snapshot;
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [diff, setDiff] = useState<TaskDiffSnapshot | null>(null);
  const [diffTask, setDiffTask] = useState<OrchestrationTask | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [action, setAction] = useState<'review' | 'integrate' | 'verify' | 'cleanup' | null>(null);
  useEffect(() => { setSelectedTaskId(null); }, [run.id]);
  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const completed = tasks.filter((task) => task.status === 'completed').length;
  const progress = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;
  const active = ['planning', 'queued', 'running', 'summarizing', 'stopping'].includes(run.status);
  const reviewed = tasks.filter((task) => (task.reviewStatus ?? 'pending') !== 'pending').length;
  const accepted = tasks.filter((task) => task.reviewStatus === 'accepted').length;
  const reviewReady = run.status === 'completed' && reviewed === tasks.length && accepted > 0;
  const integrationStatus = run.integrationStatus ?? 'pending';
  const verificationStatus = run.verificationStatus ?? 'idle';

  const openDiff = async (task: OrchestrationTask): Promise<void> => {
    setDiffTask(task);
    setDiff(null);
    setDiffLoading(true);
    onError(null);
    try {
      setDiff(await window.relay.getOrchestrationTaskDiff({ taskId: task.id }));
    } catch (cause) {
      onError(messageOf(cause));
      setDiffTask(null);
    } finally {
      setDiffLoading(false);
    }
  };

  const review = async (decision: 'accepted' | 'rejected'): Promise<void> => {
    if (!diffTask) return;
    setAction('review');
    onError(null);
    try {
      onSnapshot(await window.relay.reviewOrchestrationTask({ taskId: diffTask.id, decision }));
      setDiffTask(null);
      setDiff(null);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setAction(null);
    }
  };

  const runAction = async (kind: 'integrate' | 'verify' | 'cleanup'): Promise<void> => {
    setAction(kind);
    onError(null);
    try {
      const next = kind === 'integrate'
        ? await window.relay.integrateOrchestration({ runId: run.id })
        : kind === 'verify'
          ? await window.relay.verifyOrchestration({ runId: run.id, provider: verificationProvider ?? undefined })
          : await window.relay.cleanupOrchestration({ runId: run.id });
      onSnapshot(next);
    } catch (cause) {
      onError(messageOf(cause));
    } finally {
      setAction(null);
    }
  };

  return (
    <>
    <Card className="orchestrator-mission-card">
      <CardHeader className="orchestrator-mission-header">
        <div className="orchestrator-mission-heading">
          <span className="orchestrator-run-mark"><Icon icon={Task01Icon} size={15} /></span>
          <div><span>{strategyLabel(run.strategy)}</span><strong title={run.objective}>{run.objective}</strong></div>
        </div>
        <div className="orchestrator-run-meta">
          <StatusBadge status={run.status} />
          {(['blocked', 'failed', 'stopped'].includes(run.status)
            || run.integrationStatus === 'conflict'
            || run.integrationStatus === 'failed'
            || run.verificationStatus === 'failed') && (
            <Tooltip content="Re-plan run">
              <Button variant="ghost" size="icon" aria-label="Re-plan run" disabled={busy} onClick={() => void onReplan(snapshot)}>
                <Icon icon={RepeatIcon} size={15} />
              </Button>
            </Tooltip>
          )}
          {active && (
            <Tooltip content="Stop run">
              <Button variant="ghost" size="icon" className="danger-icon-button" aria-label="Stop run" onClick={() => void onStop(run.id)}>
                <Icon icon={SquareStopIcon} size={15} />
              </Button>
            </Tooltip>
          )}
        </div>
      </CardHeader>
      <div className="orchestrator-progress"><span style={{ width: `${progress}%` }} /></div>
      {run.status === 'completed' && (
        <div className="integration-bar">
          <div className="integration-progress-copy">
            <span>Review</span>
            <strong>{reviewed}/{tasks.length}</strong>
            <IntegrationBadge status={integrationStatus} />
            {verificationStatus !== 'idle' && <IntegrationBadge status={verificationStatus} />}
          </div>
          <div className="integration-actions">
            {integrationStatus !== 'integrated' && (
              <Tooltip content="Integrate work">
                <span className="disabled-tooltip-target">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!reviewReady || action !== null || integrationStatus === 'integrating'}
                    onClick={() => void runAction('integrate')}
                  >
                    <Icon icon={GitMergeIcon} size={13} /> Integrate
                  </Button>
                </span>
              </Tooltip>
            )}
            {integrationStatus === 'integrated' && verificationStatus !== 'running' && (
              <Tooltip content="Run verification">
                <Button size="sm" variant="secondary" disabled={action !== null} onClick={() => void runAction('verify')}>
                  <Icon icon={ShieldCheckIcon} size={13} /> Verify
                </Button>
              </Tooltip>
            )}
            {run.verificationTerminalId && (
              <Tooltip content="Open verifier">
                <Button size="icon-sm" variant="ghost" aria-label="Open verifier" onClick={() => onOpenTerminal(run.verificationTerminalId!)}>
                  <Icon icon={SquareTerminalIcon} size={13} />
                </Button>
              </Tooltip>
            )}
            {integrationStatus === 'integrated' && ['passed', 'failed'].includes(verificationStatus) && tasks.some((task) => task.worktreeId) && (
              <Tooltip content="Clean worktrees">
                <Button size="sm" variant="ghost" disabled={action !== null} onClick={() => void runAction('cleanup')}>
                  <Icon icon={CleanIcon} size={13} /> Cleanup
                </Button>
              </Tooltip>
            )}
          </div>
        </div>
      )}
      <CardContent className="orchestrator-mission-content">
        {run.status === 'planning' && (
          <div className="orchestrator-planning-state">
            <AgentAvatar seed="relay-orchestrator" name={orchestratorName} className="planning-agent-avatar" />
            <div><strong>{orchestratorName} is planning</strong><span>Inspecting the project and choosing the team.</span></div>
            {run.planningTerminalId && (
              <Tooltip content="Open planner">
                <Button size="icon-sm" variant="ghost" aria-label="Open planner" onClick={() => onOpenTerminal(run.planningTerminalId!)}>
                  <Icon icon={SquareTerminalIcon} size={13} />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {run.status === 'summarizing' && (
          <div className="orchestrator-planning-state">
            <AgentAvatar seed="relay-orchestrator" name={orchestratorName} className="planning-agent-avatar" />
            <div><strong>{orchestratorName} is reviewing</strong><span>Combining the worker outcomes.</span></div>
            {run.synthesisTerminalId && (
              <Tooltip content="Open outcome">
                <Button size="icon-sm" variant="ghost" aria-label="Open outcome" onClick={() => onOpenTerminal(run.synthesisTerminalId!)}>
                  <Icon icon={SquareTerminalIcon} size={13} />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {run.planningSummary && run.status !== 'planning' && (
          <div className={`orchestrator-plan-summary ${run.planningSource ?? 'model'}`}>
            <Icon icon={WorkflowIcon} size={14} />
            <span>{run.planningSummary}</span>
            {run.planningSource === 'fallback' && <Badge variant="secondary">Fallback</Badge>}
            {run.planningTerminalId && (
              <Tooltip content="Open planner">
                <Button size="icon-sm" variant="ghost" aria-label="Open planner" onClick={() => onOpenTerminal(run.planningTerminalId!)}>
                  <Icon icon={SquareTerminalIcon} size={13} />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
        {run.planningError && run.planningSource === 'fallback' && (
          <Alert className="planning-alert"><Icon icon={Alert02Icon} size={14} /><AlertDescription>{run.planningError}</AlertDescription></Alert>
        )}
        {run.finalSummary && run.status !== 'summarizing' && (
          <div className={`orchestrator-outcome ${run.synthesisStatus ?? 'completed'}`}>
            <div>
              <Icon icon={CheckmarkCircle02Icon} size={14} />
              <strong>Outcome</strong>
              {run.synthesisStatus === 'fallback' && <Badge variant="secondary">Fallback</Badge>}
              {run.synthesisTerminalId && (
                <Tooltip content="Open outcome">
                  <Button size="icon-sm" variant="ghost" aria-label="Open outcome" onClick={() => onOpenTerminal(run.synthesisTerminalId!)}>
                    <Icon icon={SquareTerminalIcon} size={13} />
                  </Button>
                </Tooltip>
              )}
            </div>
            <pre>{run.finalSummary}</pre>
          </div>
        )}
        {run.synthesisError && run.synthesisStatus === 'fallback' && (
          <Alert className="planning-alert"><Icon icon={Alert02Icon} size={14} /><AlertDescription>{run.synthesisError}</AlertDescription></Alert>
        )}
        {run.integrationError && (
          <Alert variant="destructive" className="integration-alert">
            <Icon icon={Alert02Icon} size={14} /><AlertDescription>{run.integrationError}</AlertDescription>
          </Alert>
        )}
        {(run.verificationSummary || run.verificationError) && (
          <div className={`verification-result ${verificationStatus}`}>
            <div><Icon icon={ShieldCheckIcon} size={13} /><strong>Verification</strong></div>
            <pre>{run.verificationError ?? run.verificationSummary}</pre>
          </div>
        )}
        <div className="orchestrator-task-board">
          {tasks.map((task) => (
            <button
              key={task.id}
              className={`orchestrator-task-card ${selectedTask?.id === task.id ? 'selected' : ''}`}
              onClick={() => setSelectedTaskId(task.id)}
            >
              <AgentAvatar seed={task.avatarSeed ?? task.id} name={task.agentName ?? personNameForSeed(task.id)} className="task-agent-avatar" />
              <span className={`orchestrator-task-provider ${task.provider}`}>
                <Icon icon={task.provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={13} />
              </span>
              <span className="orchestrator-task-card-copy">
                <small>{roleLabel(task.role)}</small>
                <strong>{task.title}</strong>
                <span>{task.agentName ?? personNameForSeed(task.id)} · {task.deliverable}</span>
              </span>
              <span className={`task-state ${task.status}`} />
              {(task.reviewStatus ?? 'pending') !== 'pending' && (
                <span className={`task-review-state ${task.reviewStatus}`}>
                  {task.reviewStatus === 'accepted' ? 'Accepted' : 'Rejected'}
                </span>
              )}
            </button>
          ))}
        </div>

        {selectedTask && (
          <TaskDetail task={selectedTask} onRetry={onRetry} onOpenTerminal={onOpenTerminal} onReview={openDiff} />
        )}
      </CardContent>
    </Card>
    <Dialog open={Boolean(diffTask)} onOpenChange={(open) => { if (!open && action !== 'review') setDiffTask(null); }}>
      <DialogContent className="diff-dialog" showCloseButton={action !== 'review'}>
        <DialogHeader>
          <DialogTitle>{diffTask?.title ?? 'Review changes'}</DialogTitle>
          <DialogDescription>{diff?.branch ?? diffTask?.branch ?? 'Task worktree'}</DialogDescription>
        </DialogHeader>
        {diffLoading ? (
          <div className="diff-loading">Loading changes…</div>
        ) : diff ? (
          <div className="diff-body">
            <div className="diff-summary">
              <Badge variant="outline">{diff.files.length} files</Badge>
              <span className="diff-additions">+{diff.additions}</span>
              <span className="diff-deletions">−{diff.deletions}</span>
              {diff.truncated && <Badge variant="secondary">Truncated</Badge>}
            </div>
            <div className="diff-files">
              {diff.files.map((file) => (
                <div key={`${file.status}-${file.path}`}>
                  <span>{fileStatusLabel(file.status)}</span>
                  <code>{file.path}</code>
                  <small><b>+{file.additions}</b> −{file.deletions}</small>
                </div>
              ))}
              {diff.files.length === 0 && <span>No file changes</span>}
            </div>
            <pre className="diff-patch">{diff.patch || 'No patch to display.'}</pre>
          </div>
        ) : null}
        <DialogFooter className="diff-footer">
          <Button variant="destructive" disabled={!diff || action === 'review'} onClick={() => void review('rejected')}>
            Reject
          </Button>
          <Button disabled={!diff || action === 'review'} onClick={() => void review('accepted')}>
            <Icon icon={CheckmarkCircle02Icon} size={13} /> Accept
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

function TaskDetail({ task, onRetry, onOpenTerminal, onReview }: {
  task: OrchestrationTask;
  onRetry: (taskId: string) => Promise<void>;
  onOpenTerminal: (terminalId: string) => void;
  onReview: (task: OrchestrationTask) => Promise<void>;
}): React.JSX.Element {
  const retryable = ['blocked', 'failed', 'stopped'].includes(task.status);
  return (
    <div className="orchestrator-task-detail">
      <div className="orchestrator-detail-main">
        <div className="orchestrator-detail-title">
          <strong>{task.title}</strong>
          {task.branch && <span><Icon icon={GitBranchIcon} size={11} />{task.branch.replace(/^(?:relay|foundry)\//, '')}</span>}
        </div>
        <p>{task.instructions}</p>
        {(task.blocker || task.error || task.integrationError || task.summary) && (
          <pre className={task.blocker || task.error || task.integrationError ? 'error' : ''}>
            {task.blocker ?? task.error ?? task.integrationError ?? task.summary}
          </pre>
        )}
      </div>
      <div className="orchestrator-detail-actions">
        <StatusBadge status={task.status} />
        {task.status === 'completed' && task.worktreeId && !['integrated', 'no_changes'].includes(task.integrationStatus ?? 'pending') && (
          <Tooltip content="Review diff">
            <Button variant="secondary" size="sm" onClick={() => void onReview(task)}>
              <Icon icon={FileViewIcon} size={13} /> Review
            </Button>
          </Tooltip>
        )}
        {task.terminalId && (
          <Tooltip content="Open terminal">
            <Button variant="secondary" size="sm" aria-label="Open terminal" onClick={() => onOpenTerminal(task.terminalId!)}>
              <Icon icon={SquareTerminalIcon} size={13} /> Terminal
            </Button>
          </Tooltip>
        )}
        {retryable && (
          <Tooltip content="Retry task">
            <Button variant="secondary" size="sm" aria-label="Retry task" onClick={() => void onRetry(task.id)}>
              <Icon icon={RepeatIcon} size={13} /> Retry
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  const variant = status === 'completed'
    ? 'default'
    : ['failed', 'blocked', 'stopped'].includes(status)
      ? 'destructive'
      : status === 'running'
        ? 'default'
        : 'secondary';
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

function IntegrationBadge({ status }: { status: string }): React.JSX.Element {
  const variant = ['integrated', 'passed'].includes(status)
    ? 'default'
    : ['conflict', 'failed'].includes(status)
      ? 'destructive'
      : 'secondary';
  return <Badge variant={variant}>{statusLabel(status)}</Badge>;
}

function fileStatusLabel(status: TaskDiffSnapshot['files'][number]['status']): string {
  return status.charAt(0).toUpperCase();
}

function roleLabel(role: OrchestrationTask['role']): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function strategyLabel(strategy: OrchestrationStrategy): string {
  return STRATEGIES.find((option) => option.id === strategy)?.label ?? 'Build';
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sessionStatusLabel(terminal: TerminalSnapshot | null): string {
  if (!terminal || terminal.status === 'starting') return 'Session starting';
  if (terminal.status === 'running') return 'Session running';
  if (terminal.status === 'stopping') return 'Session stopping';
  return 'Session stopped';
}
