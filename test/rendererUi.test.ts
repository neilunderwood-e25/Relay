import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('renderer design-system contract', () => {
  it('keeps the requested Shadcn preset configuration', () => {
    const config = JSON.parse(read('components.json')) as {
      style: string;
      iconLibrary: string;
      tailwind: { baseColor: string; cssVariables: boolean };
    };

    expect(config.style).toBe('base-nova');
    expect(config.iconLibrary).toBe('hugeicons');
    expect(config.tailwind).toMatchObject({ baseColor: 'zinc', cssVariables: true });
  });

  it('uses shared semantic colors instead of the removed teal accent', () => {
    const styles = read('src/renderer/src/styles.css');

    expect(styles).not.toMatch(/\b(?:teal|cyan|emerald)\b/i);
    expect(styles).toContain('--provider-claude:');
    expect(styles).toContain('--status-warning:');
  });

  it('keeps cards and buttons on the preset primitives', () => {
    const card = read('src/renderer/src/components/ui/Card.tsx');
    const button = read('src/renderer/src/components/ui/Button.tsx');

    expect(card).toContain('rounded-xl border border-border bg-card');
    expect(button).toContain('bg-primary text-primary-foreground');
    expect(button).toContain('disabled:opacity-50');
  });

  it('covers each renderer view with a labelled navigation target', () => {
    const sidebar = read('src/renderer/src/components/AppSidebar.tsx');

    expect(sidebar).toContain('aria-label={orchestratorName}');
    expect(sidebar).toContain('aria-label="Console"');
    expect(sidebar).toContain('aria-label="Worktrees"');
    expect(sidebar).toContain('aria-label="Activity"');
    expect(sidebar).toContain('aria-label="Agent library"');
    expect(sidebar).toContain('aria-label="Settings"');
  });

  it('builds the extension library from shared Shadcn primitives', () => {
    const library = read('src/renderer/src/components/LibraryWorkspace.tsx');
    const orchestrator = read('src/renderer/src/components/OrchestratorWorkspace.tsx');

    expect(library).toContain("from './ui/Card'");
    expect(library).toContain("from './ui/Select'");
    expect(library).toContain("from './ui/dialog'");
    expect(library).toContain('window.relay.saveAgentProfile');
    expect(library).toContain('window.relay.saveOrchestrationTemplate');
    expect(orchestrator).toContain('profileIds: selectedProfileIds');
    expect(orchestrator).toContain('templateId: selectedTemplateId');
    expect(orchestrator).toContain("run.status === 'planning'");
    expect(orchestrator).toContain('run.planningSummary');
    expect(orchestrator).toContain("run.status === 'summarizing'");
    expect(orchestrator).toContain('run.finalSummary');
    expect(orchestrator).toContain('window.relay.replanOrchestration');
    expect(orchestrator).toContain('Re-plan run');
    expect(orchestrator).toContain('window.relay.submitOrchestratorInput');
    expect(orchestrator).toContain('orchestrator-terminal-composer');
    expect(orchestrator).toContain('<OrchestratorProjection');
    expect(orchestrator).toContain('submissionRef.current');
    expect(orchestrator).toContain("run.integrationStatus === 'conflict'");
    expect(orchestrator).toContain("integrationStatus === 'integrated' && verificationStatus !== 'running'");
    expect(orchestrator).toContain("'Stop verifier'");
    expect(orchestrator).toContain('task.assignmentReason');
    expect(orchestrator).toContain('run.recommendedVerificationProvider');
  });

  it('projects the shared Michael PTY without mounting a second terminal', () => {
    const projection = read('src/renderer/src/components/OrchestratorProjection.tsx');
    expect(projection).toContain('window.relay.getOrchestratorProjection()');
    expect(projection).toContain('window.relay.onOrchestratorProjection');
    expect(projection).not.toContain('<TerminalView');
    expect(projection).toContain('aria-live="polite"');
  });

  it('provides a reusable worker console instead of anonymous terminal tabs', () => {
    const app = read('src/renderer/src/App.tsx');
    const console = read('src/renderer/src/components/TerminalWorkspace.tsx');
    expect(app).toContain("terminals.filter((terminal) => terminal.status !== 'exited').length");
    expect(console).toContain('window.relay.listAgentSessions');
    expect(console).toContain('window.relay.submitAgentSessionInput');
    expect(console).toContain('window.relay.restartAgentSession');
    expect(console).toContain('window.relay.stopAgentSession');
    expect(console).toContain('allTerminals.find(({ id }) => id === selectedId)');
    expect(console).toContain('selectedSession.terminalId');
    expect(console).toContain('selectedTerminalIsInteractive');
    expect(console).toContain("(selectedTerminal.outputMode ?? 'terminal') === 'terminal'");
    expect(console).not.toContain("(selectedTerminal.role ?? 'worker') === 'worker'");
    expect(console).toContain("terminal.role === 'orchestrator' ? 'Auto mode' : 'Interactive'");
    expect(console).toContain('compactTerminalPath(selectedTerminal.cwd)');
    expect(console).toContain('aria-label="Agent follow-up"');
    expect(console).toContain('className="agent-session-rail"');
    expect(console).not.toContain('<Tabs');
  });

  it('ships the operations views on shared UI primitives', () => {
    const activity = read('src/renderer/src/components/ActivityWorkspace.tsx');
    const settings = read('src/renderer/src/components/SettingsWorkspace.tsx');
    const worktrees = read('src/renderer/src/components/WorktreesWorkspace.tsx');
    const worktreeManager = read('src/main/worktrees.ts');

    expect(activity).toContain("from './ui/dialog'");
    expect(activity).toContain('window.relay.listActivity');
    expect(settings).toContain("from './ui/Card'");
    expect(settings).toContain('window.relay.updatePreferences');
    expect(settings).toContain('window.relay.recoverOperations');
    expect(worktrees).toContain('if (value) setBaseBranch(value)');
    expect(worktrees).toContain("{baseBranch || 'No commits'}");
    expect(worktrees).toContain('window.relay.openIdeWorkspace');
    expect(worktrees).toContain('aria-label="Open IDE workspace"');
    expect(worktrees).toContain('Worktree created, but the IDE workspace could not be opened.');
    expect(worktreeManager).toContain("['--reuse-window', workspacePath]");
    expect(worktreeManager).not.toContain("['--new-window', workspacePath]");
  });

  it('presents all worker engines with readable, shared provider states', () => {
    const providerUi = read('src/renderer/src/providerUi.ts');
    const startup = read('src/renderer/src/components/StartupWizard.tsx');
    const orchestrator = read('src/renderer/src/components/OrchestratorWorkspace.tsx');
    const settings = read('src/renderer/src/components/SettingsWorkspace.tsx');

    expect(providerUi).toContain("export type ProviderState = 'ready' | 'signin' | 'missing' | 'error'");
    expect(providerUi).toContain('providerModelOptions');
    expect(startup).toContain('providerStatusDetail(selectedProvider)');
    expect(startup).toContain('provider-option');
    expect(orchestrator).toContain('orchestrator-provider-label">Workers');
    expect(orchestrator).toContain('{providerLabel(provider.id)}');
    expect(orchestrator).toContain('knownRunIdsRef');
    expect(orchestrator).toContain('if (isNew) setSelectedRunId(snapshot.run.id)');
    expect(settings).toContain('onRefreshProviders');
    expect(settings).toContain('provider-health-copy');
  });

  it('retains compact-window layout rules without crushing terminal controls', () => {
    const styles = read('src/renderer/src/styles.css');
    const orchestrator = read('src/renderer/src/components/OrchestratorWorkspace.tsx');

    expect(styles).toContain('@media (max-height: 680px)');
    expect(styles).toContain('.terminal-card-header { min-height: 48px; padding-block: 6px; }');
    expect(styles).toContain('@media (max-width: 980px)');
    expect(styles).toContain(".orchestrator-strategy-switch [data-slot='button'][aria-pressed='true']");
    expect(styles).toContain(".orchestrator-strategy-switch [data-slot='button'].selected:hover");
    expect(styles).toContain(".orchestrator-strategy-switch [data-slot='button'][data-state='on']");
    expect(orchestrator).toContain("data-state={selected ? 'on' : 'off'}");
    expect(styles).toContain('background: var(--primary);');
  });
});
