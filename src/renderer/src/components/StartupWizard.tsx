import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight01Icon,
  ChatGptIcon,
  ClaudeIcon,
  Folder01Icon,
  FolderGitIcon
} from '@hugeicons/core-free-icons';
import type { AppSnapshot, ProviderId } from '../../../shared/contracts';
import { DEFAULT_AGENT_NAMES } from '../../../shared/contracts';
import { ORCHESTRATOR_MODELS } from '../../../shared/orchestratorModels';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { Card, CardContent, CardFooter, CardHeader } from './ui/Card';
import { Icon } from './ui/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { AgentAvatar } from './AgentAvatar';

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
    () => snapshot.providers.filter((candidate) => candidate.available),
    [snapshot.providers]
  );
  const selectedProvider = snapshot.providers.find((candidate) => candidate.id === provider);

  useEffect(() => {
    if (!selectedProvider?.available && availableProviders[0]) {
      setProvider(availableProviders[0].id);
      setModel(null);
    }
  }, [availableProviders, selectedProvider?.available]);

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
    if (!harnessHome || !projectPath || !selectedProvider?.available) return;
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
    <main className="startup-shell">
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
              <button className={`startup-folder ${harnessHome ? 'selected' : ''}`} onClick={() => void choose('home')}>
                <span className="startup-folder-icon"><Icon icon={Folder01Icon} size={17} /></span>
                <span className="startup-folder-copy">
                  <small>Harness Home</small>
                  <strong>{harnessHome ? folderName(harnessHome) : 'Choose folder'}</strong>
                  {harnessHome && <code>{harnessHome}</code>}
                </span>
                <Icon icon={ArrowRight01Icon} size={14} />
              </button>
              <button className={`startup-folder ${projectPath ? 'selected' : ''}`} onClick={() => void choose('project')}>
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
              <Badge variant="success">Orchestrator Agent</Badge>
            </div>
            <div className="startup-engine-grid">
              <div className="startup-select-field">
                <label>Engine</label>
                <Select
                  value={provider}
                  onValueChange={(value) => {
                    setProvider(value as ProviderId);
                    setModel(null);
                    setError(null);
                  }}
                >
                  <SelectTrigger aria-label="Orchestrator engine">
                    <span className={`startup-provider-mark ${provider}`}>
                      <Icon icon={provider === 'claude' ? ClaudeIcon : ChatGptIcon} size={15} />
                    </span>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {snapshot.providers.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id} disabled={!candidate.available}>
                        {DEFAULT_AGENT_NAMES[candidate.id]}{candidate.available ? '' : ' · Missing'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="startup-select-field">
                <label>Model</label>
                <Select
                  value={model ?? DEFAULT_MODEL_VALUE}
                  onValueChange={(value) => setModel(value === DEFAULT_MODEL_VALUE ? null : value)}
                >
                  <SelectTrigger aria-label="Orchestrator model"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ORCHESTRATOR_MODELS[provider].map((option) => (
                      <SelectItem key={option.id ?? DEFAULT_MODEL_VALUE} value={option.id ?? DEFAULT_MODEL_VALUE}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          {error && <div className="startup-error" role="alert">{error}</div>}
          {availableProviders.length === 0 && !error && (
            <div className="startup-error" role="alert">Install Claude or Codex CLI.</div>
          )}
        </CardContent>

        <CardFooter className="startup-card-footer">
          <span className={`startup-engine-status ${selectedProvider?.available ? 'ready' : ''}`}>
            <span />{selectedProvider?.available ? 'CLI ready' : 'CLI missing'}
          </span>
          <Button
            className="startup-next"
            disabled={!harnessHome || !projectPath || !selectedProvider?.available || busy}
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
