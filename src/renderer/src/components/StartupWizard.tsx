import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight01Icon,
  Folder01Icon,
  FolderGitIcon
} from '@hugeicons/core-free-icons';
import type { AppSnapshot, ProviderId } from '../../../shared/contracts';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Alert, AlertDescription } from './ui/alert';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { AgentAvatar } from './AgentAvatar';
import {
  providerIcon,
  providerLabel,
  providerModelLabel,
  providerModelOptions,
  providerReady,
  providerStatusDetail,
  providerStatusLabel
} from '../providerUi';

const DEFAULT_MODEL_VALUE = '__cli_default__';

interface StartupWizardProps {
  snapshot: AppSnapshot;
  onComplete: (snapshot: AppSnapshot) => void;
}

export function StartupWizard({ snapshot, onComplete }: StartupWizardProps): React.JSX.Element {
  const [harnessHome, setHarnessHome] = useState(snapshot.workspace.harnessHome ?? '');
  const [projectPath, setProjectPath] = useState(snapshot.workspace.projectPath ?? '');
  const [provider, setProvider] = useState<ProviderId>(snapshot.workspace.orchestratorProvider);
  const [model, setModel] = useState<string | null>(snapshot.workspace.orchestratorModel);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableProviders = useMemo(
    () => snapshot.providers.filter(providerReady),
    [snapshot.providers]
  );
  const selectedProvider = snapshot.providers.find((candidate) => candidate.id === provider);

  useEffect(() => {
    if ((!selectedProvider || !providerReady(selectedProvider)) && availableProviders[0]) {
      setProvider(availableProviders[0].id);
      setModel(null);
    }
  }, [availableProviders, selectedProvider]);

  const modelOptions = useMemo(
    () => providerModelOptions(provider, selectedProvider),
    [provider, selectedProvider]
  );

  const choose = async (purpose: 'home' | 'project'): Promise<void> => {
    setError(null);
    try {
      const selected = await window.relay.chooseDirectory(purpose);
      if (!selected) return;
      if (purpose === 'home') setHarnessHome(selected);
      else setProjectPath(selected);
    } catch (cause) {
      setError(messageOf(cause));
    }
  };

  const finish = async (): Promise<void> => {
    if (!harnessHome || !projectPath || !selectedProvider || !providerReady(selectedProvider)) return;
    setBusy(true);
    setError(null);
    try {
      onComplete(await window.relay.configureWorkspace({
        harnessHome,
        projectPath,
        orchestratorProvider: provider,
        orchestratorModel: model
      }));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="startup-shell" aria-busy={busy}>
      <Card className="startup-card">
        <CardHeader className="startup-card-header">
          <div className="startup-heading">
            <h1>{snapshot.workspace.onboardingComplete ? 'Open Relay' : 'Set up Relay'}</h1>
            <p>Confirm your workspace.</p>
          </div>
        </CardHeader>

        <CardContent className="startup-card-content">
          <div className="startup-section">
            <span className="startup-label">Workspace</span>
            <div className="startup-path-list">
              <button disabled={busy} className={`startup-folder ${harnessHome ? 'selected' : ''}`} onClick={() => void choose('home')}>
                <span className="startup-folder-icon"><Icon icon={Folder01Icon} size={17} /></span>
                <span className="startup-folder-copy">
                  <small>Harness Home</small>
                  <strong>{harnessHome ? folderName(harnessHome) : 'Choose folder'}</strong>
                  {harnessHome && <code>{harnessHome}</code>}
                </span>
                <Icon icon={ArrowRight01Icon} size={14} />
              </button>
              <button disabled={busy} className={`startup-folder ${projectPath ? 'selected' : ''}`} onClick={() => void choose('project')}>
                <span className="startup-folder-icon"><Icon icon={FolderGitIcon} size={17} /></span>
                <span className="startup-folder-copy">
                  <small>Project</small>
                  <strong>{projectPath ? folderName(projectPath) : 'Choose repository'}</strong>
                  {projectPath && <code>{projectPath}</code>}
                </span>
                <Icon icon={ArrowRight01Icon} size={14} />
              </button>
            </div>
          </div>

          <div className="startup-section startup-agent-section">
            <div className="startup-agent-heading">
              <AgentAvatar seed="relay-orchestrator" name="Michael" className="startup-agent-avatar" />
              <strong>Michael</strong>
              <Badge>Orchestrator Agent</Badge>
            </div>
            <div className="startup-engine-grid">
              <div className="startup-select-field">
                <label>Engine</label>
                <Select
                  disabled={busy}
                  value={provider}
                  onValueChange={(value) => {
                    setProvider(value as ProviderId);
                    setModel(null);
                    setError(null);
                  }}
                >
                  <SelectTrigger aria-label="Orchestrator engine">
                    <span className={`startup-provider-mark ${provider}`}>
                      <Icon icon={providerIcon(provider)} size={15} />
                    </span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.providers.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id} disabled={!providerReady(candidate)}>
                        <span className="provider-option">
                          <span className={`provider-option-icon ${candidate.id}`}><Icon icon={providerIcon(candidate.id)} size={14} /></span>
                          <span>{providerLabel(candidate.id)}</span>
                          {!providerReady(candidate) && <small>{providerStatusLabel(candidate)}</small>}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="startup-select-field">
                <label>Model</label>
                <Select
                  disabled={busy}
                  value={model ?? DEFAULT_MODEL_VALUE}
                  onValueChange={(value) => setModel(value === DEFAULT_MODEL_VALUE ? null : value)}
                >
                  <SelectTrigger aria-label="Orchestrator model"><SelectValue>{providerModelLabel(provider, model)}</SelectValue></SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((option) => (
                      <SelectItem key={option.id ?? DEFAULT_MODEL_VALUE} value={option.id ?? DEFAULT_MODEL_VALUE}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {error && <Alert variant="destructive" className="startup-error"><AlertDescription>{error}</AlertDescription></Alert>}
          {availableProviders.length === 0 && !error && (
            <Alert variant="destructive" className="startup-error"><AlertDescription>Install or sign in to a supported CLI.</AlertDescription></Alert>
          )}
        </CardContent>

        <CardFooter className="startup-card-footer">
          <span className={`startup-engine-status ${selectedProvider && providerReady(selectedProvider) ? 'ready' : ''}`}>
            <span />{selectedProvider ? providerStatusDetail(selectedProvider) : 'CLI unavailable'}
          </span>
          <Button
            className="startup-next"
            disabled={!harnessHome || !projectPath || !selectedProvider || !providerReady(selectedProvider) || busy}
            onClick={() => void finish()}
          >
            {busy ? 'Opening' : 'Open Relay'}
            {!busy && <Icon icon={ArrowRight01Icon} size={15} />}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
