import { useCallback, useEffect, useState } from 'react';
import {
  Cancel01Icon,
  ChatGptIcon,
  ClaudeIcon,
  FolderGitIcon,
  RefreshIcon
} from '@hugeicons/core-free-icons';
import {
  DEFAULT_AGENT_NAMES,
  type AppSnapshot,
  type ProviderCapability,
  type ProviderId
} from '../../shared/contracts';
import { AppSidebar, type AppView } from './components/AppSidebar';
import { RehanWorkspace } from './components/RehanWorkspace';
import { StartupWizard } from './components/StartupWizard';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { WorktreesWorkspace } from './components/WorktreesWorkspace';
import { Badge } from './components/ui/Badge';
import { Button } from './components/ui/Button';
import { Icon } from './components/ui/Icon';
import { Tooltip, TooltipProvider } from './components/ui/Tooltip';
import { useTerminalStore } from './store/terminals';
import relayLogo from './assets/relay-logo.svg';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; snapshot: AppSnapshot };

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [cwd, setCwd] = useState('');
  const [activeView, setActiveView] = useState<AppView>('rehan');
  const [launching, setLaunching] = useState<ProviderId | null>(null);
  const hydrate = useTerminalStore((store) => store.hydrate);
  const upsert = useTerminalStore((store) => store.upsert);
  const selectTerminal = useTerminalStore((store) => store.select);
  const markOutput = useTerminalStore((store) => store.markOutput);
  const markExited = useTerminalStore((store) => store.markExited);
  const terminalError = useTerminalStore((store) => store.error);
  const setTerminalError = useTerminalStore((store) => store.setError);
  const terminals = useTerminalStore((store) => store.terminals);

  const load = useCallback(async () => {
    try {
      const [snapshot, activeTerminals] = await Promise.all([
        window.relay.getSnapshot(),
        window.relay.listTerminals()
      ]);
      hydrate(activeTerminals);
      setCwd(snapshot.defaultWorkingDirectory);
      setState({ status: 'ready', snapshot });
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'The main process did not respond.'
      });
    }
  }, [hydrate]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const unsubscribeData = window.relay.onTerminalData(markOutput);
    const unsubscribeExit = window.relay.onTerminalExit(markExited);
    return () => {
      unsubscribeData();
      unsubscribeExit();
    };
  }, [markExited, markOutput]);

  useEffect(() => window.relay.onOrchestrationUpdate(() => {
    void window.relay.listTerminals().then(hydrate);
  }), [hydrate]);

  const refreshProviders = async (): Promise<void> => {
    if (state.status !== 'ready') return;
    try {
      const providers = await window.relay.refreshProviders();
      setState({ status: 'ready', snapshot: { ...state.snapshot, providers } });
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    }
  };

  const renameOrchestrator = async (name: string): Promise<boolean> => {
    if (state.status !== 'ready') return false;
    try {
      const snapshot = await window.relay.renameOrchestrator({ name });
      setState({ status: 'ready', snapshot });
      return true;
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  const chooseDirectory = async (): Promise<void> => {
    try {
      const selected = await window.relay.chooseDirectory('project');
      if (!selected || state.status !== 'ready' || !state.snapshot.workspace.harnessHome) return;
      const snapshot = await window.relay.configureWorkspace({
        harnessHome: state.snapshot.workspace.harnessHome,
        projectPath: selected
      });
      setCwd(snapshot.defaultWorkingDirectory);
      setState({ status: 'ready', snapshot });
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    }
  };

  const launch = async (
    provider: ProviderId,
    workingDirectory = cwd,
    worktreeLabel?: string
  ): Promise<boolean> => {
    if (!workingDirectory.trim()) {
      setTerminalError('Choose a project first.');
      return false;
    }
    setLaunching(provider);
    setTerminalError(null);
    try {
      const ordinal = terminals.filter(
        (terminal) => terminal.role !== 'orchestrator' && terminal.provider === provider
      ).length + 1;
      const terminal = await window.relay.spawnTerminal({
        provider,
        cwd: workingDirectory.trim(),
        name: worktreeLabel
          ? `${DEFAULT_AGENT_NAMES[provider]} · ${worktreeLabel}`.slice(0, 80)
          : `${DEFAULT_AGENT_NAMES[provider]} ${ordinal}`,
        cols: 120,
        rows: 32
      });
      upsert(terminal);
      return true;
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setLaunching(null);
    }
  };

  const openTerminal = async (terminalId: string): Promise<void> => {
    try {
      const activeTerminals = await window.relay.listTerminals();
      hydrate(activeTerminals);
      if (activeTerminals.some((terminal) => terminal.id === terminalId)) selectTerminal(terminalId);
      setActiveView('console');
    } catch (error) {
      setTerminalError(error instanceof Error ? error.message : String(error));
    }
  };

  if (state.status === 'loading') return <LoadingScreen />;

  if (state.status === 'error') {
    return (
      <main className="center-state error-state">
        <div className="error-mark">!</div>
        <h1>Unable to start</h1>
        <p>{state.message}</p>
        <Button onClick={() => void load()}>Retry</Button>
      </main>
    );
  }

  const { snapshot } = state;
  if (!snapshot.workspace.onboardingComplete) {
    return (
      <TooltipProvider delayDuration={250}>
        <div className="relay-shell">
          <AppTitlebar snapshot={snapshot} projectName="No project" />
          <StartupWizard onComplete={(configured) => {
            setCwd(configured.defaultWorkingDirectory);
            setState({ status: 'ready', snapshot: configured });
          }} />
        </div>
      </TooltipProvider>
    );
  }

  const runningCount = terminals.filter(
    (terminal) => terminal.role !== 'orchestrator' && terminal.status !== 'exited'
  ).length;
  const projectName = projectNameFromPath(cwd);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="relay-shell">
        <AppTitlebar snapshot={snapshot} projectName={projectName} />

        <div className="application-body">
          <AppSidebar
            activeView={activeView}
            orchestratorName={snapshot.workspace.orchestratorName}
            onNavigate={setActiveView}
            onChooseDirectory={() => void chooseDirectory()}
          />

          <main className="dashboard-inset">
            {activeView === 'rehan' ? (
              <RehanWorkspace
                cwd={cwd}
                providers={snapshot.providers}
                orchestratorName={snapshot.workspace.orchestratorName}
                onRenameOrchestrator={renameOrchestrator}
                onChooseDirectory={() => void chooseDirectory()}
                onOpenTerminal={(terminalId) => void openTerminal(terminalId)}
              />
            ) : activeView === 'console' ? (
              <>
                <header className="dashboard-header">
                  <div className="dashboard-title">
                    <h1>Console</h1>
                    <Badge variant={runningCount > 0 ? 'success' : 'secondary'}>{runningCount}</Badge>
                  </div>
                  <div className="worker-actions">
                    {snapshot.providers.map((provider) => (
                      <ProviderButton
                        key={provider.id}
                        provider={provider}
                        launching={launching === provider.id}
                        disabled={launching !== null}
                        onClick={() => void launch(provider.id)}
                      />
                    ))}
                    <Tooltip content="Refresh providers">
                      <Button variant="ghost" size="icon" aria-label="Refresh providers" onClick={() => void refreshProviders()}>
                        <Icon icon={RefreshIcon} size={16} />
                      </Button>
                    </Tooltip>
                  </div>
                </header>

                {terminalError && (
                  <div className="inline-error" role="alert">
                    <span>{terminalError}</span>
                    <Tooltip content="Dismiss error">
                      <Button variant="ghost" size="icon" aria-label="Dismiss error" onClick={() => setTerminalError(null)}>
                        <Icon icon={Cancel01Icon} size={15} />
                      </Button>
                    </Tooltip>
                  </div>
                )}

                <TerminalWorkspace />
              </>
            ) : (
              <WorktreesWorkspace
                cwd={cwd}
                providers={snapshot.providers}
                onChooseDirectory={() => void chooseDirectory()}
                onLaunch={async (provider, worktreeCwd, label) => {
                  if (await launch(provider, worktreeCwd, label)) setActiveView('console');
                }}
              />
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

function AppTitlebar({ snapshot, projectName }: {
  snapshot: AppSnapshot;
  projectName: string;
}): React.JSX.Element {
  return (
    <header className="app-titlebar">
      <div className="brand-block">
        <Tooltip content="Relay" side="bottom">
          <span className="titlebar-icon-target">
            <img className="brand-logo" src={relayLogo} alt="Relay" />
          </span>
        </Tooltip>
        <strong>Relay</strong>
      </div>
      <div className="titlebar-project">
        <Tooltip content="Current project" side="bottom">
          <span className="titlebar-icon-target">
            <Icon icon={FolderGitIcon} size={14} />
          </span>
        </Tooltip>
        <span>{projectName}</span>
      </div>
      <div className="titlebar-status">
        <Tooltip content="Runtime online" side="bottom">
          <span className="titlebar-icon-target"><span className="online-dot" /></span>
        </Tooltip>
        <Badge variant="outline">v{snapshot.appVersion}</Badge>
      </div>
    </header>
  );
}

function ProviderButton({ provider, launching, disabled, onClick }: {
  provider: ProviderCapability;
  launching: boolean;
  disabled: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const label = DEFAULT_AGENT_NAMES[provider.id];
  return (
    <Tooltip content={`${label} CLI`}>
      <span className="disabled-tooltip-target">
        <Button
          variant="secondary"
          size="sm"
          disabled={!provider.available || disabled}
          onClick={onClick}
          className={`worker-button worker-${provider.id}`}
        >
          <Icon icon={provider.id === 'claude' ? ClaudeIcon : ChatGptIcon} size={15} />
          {launching ? 'Starting' : label}
        </Button>
      </span>
    </Tooltip>
  );
}

function LoadingScreen(): React.JSX.Element {
  return (
    <main className="center-state loading-state">
      <img className="brand-logo loading-brand" src={relayLogo} alt="Relay" />
      <span className="loading-line" />
    </main>
  );
}

function projectNameFromPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || 'No project';
}
