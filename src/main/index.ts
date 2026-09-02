import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import type { Logger } from 'pino';
import type {
  AgentSessionInputRequest,
  AgentSessionRequest,
  AgentProfileSaveRequest,
  ActivityListRequest,
  AppSnapshot,
  ExtensionDeleteRequest,
  OrchestratorActionRequest,
  OrchestratorActionResult,
  OrchestratorInputRequest,
  OrchestratorRenameRequest,
  OrchestrationCreateRequest,
  OrchestrationReplanRequest,
  OrchestrationReviewRequest,
  OrchestrationRunRequest,
  OrchestrationSnapshot,
  OrchestrationTaskRequest,
  OrchestrationTemplateSaveRequest,
  OrchestrationVerifyRequest,
  PreferencesUpdateRequest,
  RelayControlKind,
  RelayPreferences,
  RuntimeDiagnostics,
  TerminalSnapshot,
  TerminalSpawnRequest,
  WorkspaceConfig,
  WorkspaceConfigureRequest,
  WorktreeCreateRequest,
  WorktreeRemoveRequest
} from '../shared/contracts';
import {
  DEFAULT_ORCHESTRATOR_NAME,
  PROVIDER_IDS
} from '../shared/contracts';
import { IPC } from '../shared/ipc';
import {
  DEFAULT_ORCHESTRATOR_PROVIDER
} from '../shared/orchestratorModels';
import { WorkspaceConfigStore } from './config';
import { orchestratorSessionPrompt, RelayControlProtocol } from './controlProtocol';
import { RelayDatabase } from './database';
import { ExtensionRegistry } from './extensions';
import { HiveManager } from './hive';
import { LiveMonitorProjection } from './liveProjection';
import { createAppLogger } from './logger';
import { Orchestrator } from './orchestrator';
import { OrchestratorActionBridge } from './orchestratorActions';
import { prepareOrchestratorTerminal, prepareWorkerTerminal } from './orchestratorBootstrap';
import { providerAdapter } from './providerAdapters';
import {
  createNativeWorkerSessionId,
  readNativeWorkerResult,
  resolveNativeWorkerSessionId
} from './providerSessions';
import { detectProviders, isProviderReady } from './providers';
import { PtyManager } from './pty';
import { normalizePreferences } from './preferences';
import { SafetyBoundary } from './safety';
import { WorktreeManager } from './worktrees';
import { isNestedPath, validateWorkspaceRequest } from './workspaceValidation';

app.setName('Relay');

const EMPTY_WORKSPACE: WorkspaceConfig = {
  onboardingComplete: false,
  harnessHome: null,
  projectPath: null,
  orchestratorName: DEFAULT_ORCHESTRATOR_NAME,
  orchestratorProvider: DEFAULT_ORCHESTRATOR_PROVIDER,
  orchestratorModel: null
};

let mainWindow: BrowserWindow | null = null;
let logger: Logger | null = null;
let relayLogPath = '';
let configStore: WorkspaceConfigStore | null = null;
let workspaceConfig: WorkspaceConfig = { ...EMPTY_WORKSPACE };
let database: RelayDatabase | null = null;
let hive: HiveManager | null = null;
let ptyManager: PtyManager | null = null;
let worktreeManager: WorktreeManager | null = null;
let orchestrator: Orchestrator | null = null;
let extensions: ExtensionRegistry | null = null;
let controlProtocol: RelayControlProtocol | null = null;
let actionBridge: OrchestratorActionBridge | null = null;
let monitorProjection: LiveMonitorProjection | null = null;
let safetyBoundary: SafetyBoundary | null = null;
let orchestratorSessionStart: Promise<TerminalSnapshot> | null = null;

process.on('uncaughtExceptionMonitor', (error, origin) => {
  logger?.fatal({ error, origin }, 'Uncaught main-process exception');
});
process.on('unhandledRejection', (reason) => {
  logger?.error({ reason }, 'Unhandled main-process rejection');
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'Relay',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 17 } : undefined,
    show: false,
    backgroundColor: '#07090f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.once('ready-to-show', () => window.show());
  window.on('unresponsive', () => logger?.warn('Renderer became unresponsive'));
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.error({ details }, 'Renderer process exited unexpectedly');
    database?.appendEvent('app.renderer.crashed', { reason: details.reason, exitCode: details.exitCode });
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => logger?.error({ error }, 'Renderer failed to load'));
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html')).catch((error) => logger?.error({ error }, 'Renderer failed to load'));
  }

  return window;
}

async function buildAppSnapshot(): Promise<AppSnapshot> {
  const home = workspaceConfig.harnessHome;
  return {
    appName: app.getName(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    defaultWorkingDirectory: workspaceConfig.projectPath ?? '',
    database: database?.health() ?? {
      open: false,
      path: home ? join(home, 'relay.db') : '',
      schemaVersion: 0
    },
    hive: hive?.health() ?? {
      ready: false,
      path: home ? join(home, 'hive') : '',
      agentPath: home ? join(home, 'hive', 'agents', 'orchestrator') : ''
    },
    workspace: { ...workspaceConfig },
    preferences: readPreferences(),
    agentProfiles: extensions?.listProfiles() ?? [],
    orchestrationTemplates: extensions?.listTemplates() ?? [],
    providers: await detectProviders()
  };
}

function readPreferences(): RelayPreferences {
  const stored = database?.getValue<Partial<RelayPreferences>>('preferences');
  return normalizePreferences(stored);
}

async function buildDiagnostics(): Promise<RuntimeDiagnostics> {
  if (!database || !workspaceConfig.projectPath) throw new Error('Finish setup first.');
  const repository = await worktreeManager?.inspect(workspaceConfig.projectPath);
  const runs = database.listOrchestrations(repository?.mainRoot ?? workspaceConfig.projectPath);
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    activeTerminals: ptyManager?.list().filter((terminal) => terminal.status !== 'exited').length ?? 0,
    runningOrchestrations: runs.filter(({ run }) =>
      ['planning', 'queued', 'running', 'summarizing', 'stopping'].includes(run.status)
    ).length,
    managedWorktrees: repository?.worktrees.filter((worktree) => worktree.managed && !worktree.isMain).length ?? 0,
    missingWorktrees: repository?.worktrees.filter((worktree) => worktree.status === 'missing').length ?? 0,
    activityEvents: database.countEvents(),
    databasePath: database.health().path,
    hivePath: hive?.health().path ?? '',
    logPath: relayLogPath
  };
}

async function ensureOrchestratorSession(
  config = workspaceConfig,
  activeHive = hive,
  activePtyManager = ptyManager,
  activeDatabase = database
): Promise<TerminalSnapshot> {
  if (!activePtyManager || !activeHive || !config.onboardingComplete || !config.projectPath) {
    throw new Error('Finish setup first.');
  }
  if (orchestratorSessionStart) return orchestratorSessionStart;
  const existing = activePtyManager.list().find(
    (terminal) => terminal.role === 'orchestrator' && terminal.status !== 'exited'
  );
  if (existing) return existing;

  const pending = startOrchestratorSession(config, activeHive, activePtyManager, activeDatabase);
  orchestratorSessionStart = pending;
  try {
    return await pending;
  } finally {
    if (orchestratorSessionStart === pending) orchestratorSessionStart = null;
  }
}

async function startOrchestratorSession(
  config: WorkspaceConfig,
  activeHive: HiveManager,
  activePtyManager: PtyManager,
  activeDatabase: RelayDatabase | null
): Promise<TerminalSnapshot> {
  const prompt = orchestratorSessionPrompt(config.orchestratorName, config.projectPath!, activeHive.root);
  const terminal = await activePtyManager.spawn({
    provider: config.orchestratorProvider,
    role: 'orchestrator',
    avatarSeed: 'relay-orchestrator',
    cwd: activeHive.agentRoot,
    name: config.orchestratorName,
    cols: 120,
    rows: 32,
    args: providerAdapter(config.orchestratorProvider).orchestratorArgs(
      prompt,
      activeHive.root,
      config.orchestratorModel
    )
  });
  try {
    monitorProjection?.attach(terminal, activePtyManager.replay(terminal.id).data);
  } catch {
    monitorProjection?.attach(terminal);
  }
  activeDatabase?.appendEvent('terminal.started', {
    terminalId: terminal.id,
    provider: terminal.provider,
    role: 'orchestrator',
    cwd: terminal.cwd
  });
  const prepared = await prepareOrchestratorTerminal(terminal, activeHive.agentRoot, activePtyManager);
  if (prepared.acceptedWorkspaceTrust) {
    activeDatabase?.appendEvent('terminal.workspace_trusted', {
      terminalId: terminal.id,
      provider: terminal.provider,
      cwd: terminal.cwd
    });
    logger?.info({ terminalId: terminal.id, cwd: terminal.cwd }, 'Relay Hive trust accepted for Michael');
  }
  return prepared.terminal;
}

function dispatchControl(
  kind: RelayControlKind,
  snapshot: OrchestrationSnapshot,
  payload: Record<string, string | number | boolean | null> = {},
  taskId?: string
): void {
  if (!controlProtocol) return;
  try {
    controlProtocol.dispatch({
      kind,
      projectPath: snapshot.run.repoRoot,
      runId: snapshot.run.id,
      taskId,
      objective: snapshot.run.objective,
      strategy: snapshot.run.strategy,
      payload
    });
  } catch (error) {
    logger?.warn({ kind, runId: snapshot.run.id, error }, 'Relay control command could not be queued');
  }
}

async function executeOrchestratorAction(
  action: OrchestratorActionRequest,
  activeOrchestrator: Orchestrator,
  activeDatabase: RelayDatabase,
  activeSafety: SafetyBoundary
): Promise<OrchestratorActionResult> {
  const completed = (
    summary: string,
    snapshot?: OrchestrationSnapshot,
    taskId = action.taskId
  ): OrchestratorActionResult => ({
    version: 1,
    actionId: action.id,
    kind: action.kind,
    status: 'completed',
    completedAt: Date.now(),
    runId: snapshot?.run.id ?? action.runId,
    taskId,
    summary
  });

  if (action.kind === 'run.create') {
    if (!workspaceConfig.projectPath) throw new Error('No project is selected.');
    activeSafety.assertProjectPath(workspaceConfig.projectPath, 'action.run.create');
    const snapshot = await activeOrchestrator.create({
      repoPath: workspaceConfig.projectPath,
      objective: action.objective!,
      strategy: action.strategy,
      providers: action.providers,
      concurrency: action.concurrency,
      profileIds: action.profileIds,
      templateId: action.templateId
    });
    dispatchControl('run.started', snapshot, {
      concurrency: snapshot.run.concurrency,
      baseBranch: snapshot.run.baseBranch,
      inputId: action.inputId ?? null
    });
    return completed('Monitor run created.', snapshot);
  }
  if (action.kind === 'run.stop') {
    activeSafety.assertRun(action.runId, 'action.run.stop');
    const result = await activeOrchestrator.stop(action.runId!);
    if (!result.ok) throw new Error(result.error ?? 'Could not stop the run.');
    const snapshot = activeDatabase.getOrchestration(action.runId!);
    if (snapshot) dispatchControl('run.stopped', snapshot);
    return completed('Run stopped.', snapshot);
  }
  if (action.kind === 'run.replan') {
    activeSafety.assertRun(action.runId, 'action.run.replan');
    const snapshot = await activeOrchestrator.replan({ runId: action.runId! });
    dispatchControl('run.replanned', snapshot, { parentRunId: action.runId! });
    return completed('Replacement run created.', snapshot);
  }
  if (action.kind === 'task.retry') {
    activeSafety.assertTask(action.taskId, 'action.task.retry');
    const result = await activeOrchestrator.retry({ taskId: action.taskId! });
    if (!result.ok) throw new Error(result.error ?? 'Could not retry the task.');
    const task = activeDatabase.getOrchestrationTask(action.taskId!);
    const snapshot = task ? activeDatabase.getOrchestration(task.runId) : undefined;
    if (snapshot) dispatchControl('task.retried', snapshot, {}, action.taskId);
    return completed('Task retry started.', snapshot, action.taskId);
  }
  if (action.kind === 'task.review') {
    activeSafety.assertTask(action.taskId, 'action.task.review');
    const snapshot = await activeOrchestrator.review({ taskId: action.taskId!, decision: action.decision! });
    dispatchControl('task.reviewed', snapshot, { decision: action.decision! }, action.taskId);
    return completed(`Task ${action.decision}.`, snapshot, action.taskId);
  }
  if (action.kind === 'run.integrate') {
    activeSafety.assertRun(action.runId, 'action.run.integrate');
    const snapshot = await activeOrchestrator.integrate({ runId: action.runId! });
    dispatchControl('run.integrated', snapshot, { status: snapshot.run.integrationStatus ?? 'pending' });
    return completed('Integration finished.', snapshot);
  }
  if (action.kind === 'run.verify') {
    activeSafety.assertRun(action.runId, 'action.run.verify');
    const snapshot = await activeOrchestrator.verify({ runId: action.runId!, provider: action.provider });
    dispatchControl('run.verification_requested', snapshot, { provider: action.provider ?? null });
    return completed('Verification started.', snapshot);
  }
  activeSafety.assertRun(action.runId, 'action.run.cleanup');
  const snapshot = await activeOrchestrator.cleanup({ runId: action.runId! });
  dispatchControl('run.cleaned', snapshot);
  return completed('Run worktrees cleaned.', snapshot);
}

function validateOrchestratorInput(value: unknown): OrchestratorInputRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid orchestrator input.');
  const request = value as Partial<OrchestratorInputRequest>;
  const text = request.text?.trim();
  if (!text || text.length > 32_768) throw new Error('Enter an instruction under 32 KB.');
  if (!['balanced', 'parallel', 'audit'].includes(request.strategy ?? '')) throw new Error('Choose a valid run mode.');
  if (!Array.isArray(request.providers) || request.providers.length < 1 || request.providers.length > 3
    || request.providers.some((provider) => !PROVIDER_IDS.includes(provider))) {
    throw new Error('Choose at least one available CLI worker.');
  }
  if (!Number.isInteger(request.concurrency) || request.concurrency! < 1 || request.concurrency! > 4) {
    throw new Error('Concurrency must be between 1 and 4.');
  }
  if (request.profileIds !== undefined && (!Array.isArray(request.profileIds) || request.profileIds.length > 4
    || request.profileIds.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new Error('Invalid agent profile selection.');
  }
  return {
    text,
    strategy: request.strategy!,
    providers: [...new Set(request.providers)],
    concurrency: request.concurrency!,
    profileIds: request.profileIds?.map((id) => id.trim()),
    templateId: typeof request.templateId === 'string' && request.templateId.trim()
      ? request.templateId.trim()
      : undefined
  };
}

function bootstrapWorkspace(config: WorkspaceConfig): void {
  if (database && hive && worktreeManager && orchestrator) return;
  if (!logger || !ptyManager) throw new Error('Relay is not ready yet.');
  if (!config.harnessHome) throw new Error('Choose a Harness Home.');

  const harnessHome = config.harnessHome;
  const nextDatabase = new RelayDatabase(migrateLegacyDatabase(harnessHome));
  const nextHive = new HiveManager(
    join(harnessHome, 'hive'),
    config.orchestratorName,
    config.orchestratorProvider,
    config.orchestratorModel
  );
  try {
    nextDatabase.open();
    const hiveHealth = nextHive.ensure();
    if (!hiveHealth.ready) throw new Error(hiveHealth.error ?? 'Unable to initialize the hive.');

    const nextWorktrees = new WorktreeManager({
      database: nextDatabase,
      logger,
      storageRoot: join(harnessHome, 'worktrees')
    });
    const nextExtensions = new ExtensionRegistry(nextDatabase);
    const nextSafety = new SafetyBoundary(nextDatabase, () => workspaceConfig.projectPath);
    const nextControlProtocol = new RelayControlProtocol({
      hive: nextHive,
      terminals: ptyManager,
      logger,
      ensureTerminal: () => ensureOrchestratorSession(workspaceConfig, nextHive, ptyManager, nextDatabase),
      projectPath: () => workspaceConfig.projectPath ?? '',
      onDeliveryState: (state, command) => {
        if (state === 'delivering') {
          monitorProjection?.begin(
            command.id,
            command.kind === 'input.submitted' ? 'Reading input' : 'Syncing Monitor'
          );
        } else {
          monitorProjection?.end(command.id, state === 'failed');
        }
      }
    });
    const nextOrchestrator = new Orchestrator({
      database: nextDatabase,
      logger,
      worktrees: nextWorktrees,
      terminals: ptyManager,
      detectProviders,
      getOrchestratorName: () => workspaceConfig.orchestratorName,
      getOrchestratorConfig: () => ({
        provider: workspaceConfig.orchestratorProvider,
        model: workspaceConfig.orchestratorModel
      }),
      prepareWorkerTerminal: async (terminal, worktreePath) => {
        const prepared = await prepareWorkerTerminal(terminal, worktreePath, ptyManager!);
        if (prepared.acceptedWorkspaceTrust) {
          nextDatabase.appendEvent('terminal.workspace_trusted', {
            terminalId: terminal.id,
            provider: terminal.provider,
            cwd: terminal.cwd,
            role: 'worker'
          });
          logger?.info({ terminalId: terminal.id, cwd: terminal.cwd }, 'Relay worktree trust accepted for worker');
        }
        return prepared.terminal;
      },
      resolveWorkerSessionId: resolveNativeWorkerSessionId,
      createWorkerSessionId: createNativeWorkerSessionId,
      readWorkerResult: (provider, cwd, nativeSessionId, startedAt, requiredMarker) => readNativeWorkerResult(
        provider,
        cwd,
        nativeSessionId,
        startedAt,
        { requiredMarker }
      ),
      onCoordinationMessage: (message) => nextHive.appendMessage(message),
      onUpdate: (snapshot) => {
        nextHive.syncOrchestrations(nextDatabase.listOrchestrations());
        nextControlProtocol.syncSnapshot(snapshot);
        monitorProjection?.recordRun(snapshot);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.orchestrationUpdate, snapshot);
        }
      }
    });
    const nextActionBridge = new OrchestratorActionBridge({
      hive: nextHive,
      logger,
      execute: (action) => executeOrchestratorAction(action, nextOrchestrator, nextDatabase, nextSafety),
      onResult: (action, result) => {
        monitorProjection?.record(
          'action',
          result.status === 'rejected'
            ? 'Action rejected'
            : action?.kind === 'run.create' ? 'Run created' : 'Action complete'
        );
        nextControlProtocol.dispatch({
          kind: result.status === 'completed' ? 'action.completed' : 'action.rejected',
          projectPath: workspaceConfig.projectPath ?? '',
          runId: result.runId ?? action?.inputId ?? action?.id ?? result.actionId,
          taskId: result.taskId,
          objective: action?.objective ?? result.summary ?? 'Michael action',
          strategy: action?.strategy ?? 'balanced',
          payload: {
            actionId: result.actionId,
            actionKind: result.kind,
            status: result.status,
            summary: result.summary ?? null,
            error: result.error ?? null
          }
        }, 'relay');
      }
    });

    const recoveredItems = nextOrchestrator.recover();
    const recoveryFailures = nextOrchestrator.reconcileRecoveredSessions();
    nextHive.syncOrchestrations(nextDatabase.listOrchestrations());
    nextDatabase.appendEvent('app.started', {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    });
    database = nextDatabase;
    hive = nextHive;
    worktreeManager = nextWorktrees;
    extensions = nextExtensions;
    orchestrator = nextOrchestrator;
    controlProtocol = nextControlProtocol;
    actionBridge = nextActionBridge;
    safetyBoundary = nextSafety;
    nextActionBridge.start();
    const replayedControls = nextControlProtocol.recover();
    nextHive.recordRecovery(recoveredItems, replayedControls);
    if (recoveredItems > 0 || replayedControls > 0 || recoveryFailures > 0) {
      nextDatabase.appendEvent('app.recovery.completed', {
        recoveredItems,
        replayedControls,
        recoveryFailures,
        automatic: true
      });
    }
  } catch (error) {
    nextDatabase.close();
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrateLegacyDatabase(harnessHome: string): string {
  const path = join(harnessHome, 'relay.db');
  const legacyPath = join(harnessHome, 'foundry.db');
  if (!existsSync(path) && existsSync(legacyPath)) {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${legacyPath}${suffix}`;
      if (existsSync(source)) renameSync(source, `${path}${suffix}`);
    }
    logger?.info({ from: legacyPath, to: path }, 'Migrated legacy database');
  }
  return path;
}

function applicationConfigPath(appData: string): string {
  const path = join(appData, 'config.json');
  const applicationData = app.getPath('appData');
  const legacyPath = join(applicationData, 'foundry-harness', 'config.json');
  if (!existsSync(path) && isNestedPath(applicationData, appData) && existsSync(legacyPath)) {
    mkdirSync(appData, { recursive: true });
    copyFileSync(legacyPath, path);
  }
  return path;
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.appSnapshot, () => buildAppSnapshot());
  ipcMain.handle(IPC.providersRefresh, () => detectProviders({ force: true }));
  ipcMain.handle(IPC.chooseDirectory, async (_event, purpose: unknown) => {
    const isHome = purpose === 'home';
    const options: Electron.OpenDialogOptions = {
      title: isHome ? 'Choose Harness Home' : 'Choose a Git project',
      buttonLabel: isHome ? 'Use as Home' : 'Use Project',
      properties: isHome ? ['openDirectory', 'createDirectory'] : ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC.workspaceConfigure, async (_event, request: WorkspaceConfigureRequest) => {
    const nextConfig = validateWorkspaceRequest(request, workspaceConfig.orchestratorName);
    if (database && workspaceConfig.harnessHome !== nextConfig.harnessHome) {
      throw new Error('Restart Relay to change the Harness Home.');
    }
    const provider = (await detectProviders()).find(({ id }) => id === nextConfig.orchestratorProvider);
    if (!provider || !isProviderReady(provider)) {
      throw new Error(provider?.authenticationError
        ?? `${provider?.label ?? nextConfig.orchestratorProvider} is not available.`);
    }
    const previousConfig = workspaceConfig;
    workspaceConfig = nextConfig;
    try {
      bootstrapWorkspace(nextConfig);
      workspaceConfig = configStore?.write(nextConfig) ?? nextConfig;
      database?.appendEvent('app.workspace.configured', {
        projectPath: nextConfig.projectPath,
        orchestratorProvider: nextConfig.orchestratorProvider,
        orchestratorModel: nextConfig.orchestratorModel
      });
    } catch (error) {
      workspaceConfig = previousConfig;
      throw error;
    }
    return buildAppSnapshot();
  });
  ipcMain.handle(IPC.orchestratorRename, async (_event, request: OrchestratorRenameRequest) => {
    const name = request?.name?.trim();
    if (!name || name.length > 32 || !/^[\p{L}\p{N}][\p{L}\p{N} .'-]*$/u.test(name)) {
      throw new Error('Use a name between 1 and 32 characters.');
    }
    if (!workspaceConfig.onboardingComplete) throw new Error('Finish setup first.');
    workspaceConfig = configStore?.write({ ...workspaceConfig, orchestratorName: name })
      ?? { ...workspaceConfig, orchestratorName: name };
    hive?.renameOrchestrator(name);
    database?.appendEvent('app.orchestrator.renamed', { name });
    return buildAppSnapshot();
  });
  ipcMain.handle(IPC.orchestratorSessionEnsure, () => ensureOrchestratorSession());
  ipcMain.handle(IPC.orchestratorInputSubmit, (_event, request: unknown) => {
    if (!controlProtocol || !workspaceConfig.projectPath) throw new Error('Finish setup first.');
    const input = validateOrchestratorInput(request);
    monitorProjection?.record('input', 'Input queued');
    return controlProtocol.submitInput(input);
  });
  ipcMain.handle(IPC.orchestratorProjectionGet, () => monitorProjection?.snapshot() ?? {
    terminalId: null,
    status: 'starting',
    updatedAt: Date.now(),
    lastSequence: 0,
    lines: [],
    events: []
  });
  ipcMain.handle(IPC.repositoryInspect, (_event, directory: unknown) => {
    if (!worktreeManager || !safetyBoundary) throw new Error('Worktree manager is not ready.');
    const projectPath = safetyBoundary.assertProjectPath(directory, 'repository.inspect');
    return worktreeManager.inspect(projectPath).then(async (repository) => {
      if (repository.isRepository && repository.worktrees.some((worktree) => !worktree.isMain)) {
        try {
          await worktreeManager!.prepareIdeWorkspace(projectPath);
        } catch (error) {
          logger?.warn({ error, projectPath }, 'Could not refresh the IDE workspace');
        }
      }
      return repository;
    });
  });
  ipcMain.handle(IPC.worktreeCreate, (_event, request: WorktreeCreateRequest) => {
    if (!worktreeManager || !safetyBoundary || !request || typeof request !== 'object') {
      throw new Error('Worktree manager is not ready.');
    }
    const repoPath = safetyBoundary.assertProjectPath(request.repoPath, 'worktree.create');
    return worktreeManager.create({ ...request, repoPath });
  });
  ipcMain.handle(IPC.worktreeRemove, async (_event, request: WorktreeRemoveRequest) => {
    if (!worktreeManager || !database || !safetyBoundary || !request || typeof request.id !== 'string') {
      return { ok: false, error: 'Invalid worktree request.' };
    }
    const record = safetyBoundary.assertWorktree(request.id, 'worktree.remove');
    const safeRepoPath = !record
      ? safetyBoundary.assertProjectPath(request.repoPath, 'worktree.remove')
      : undefined;
    const repository = !record && typeof request.repoPath === 'string'
      ? await worktreeManager.inspect(safeRepoPath!)
      : null;
    const targetPath = record?.path
      ?? repository?.worktrees.find((worktree) => worktree.id === request.id)?.path;
    if (record && orchestrator) {
      const lifecycle = orchestrator.canRemoveWorktree(record.id);
      if (!lifecycle.ok) return lifecycle;
    }
    const inUse = targetPath && ptyManager?.list().some((terminal) =>
      terminal.status !== 'exited' && resolve(terminal.cwd) === resolve(targetPath)
    );
    if (inUse) return { ok: false, error: 'Stop the worktree terminal first.' };
    const result = await worktreeManager.remove({ ...request, repoPath: safeRepoPath });
    if (result.ok && record && orchestrator) await orchestrator.finalizeWorktreeRemoval(record.id);
    return result;
  });
  ipcMain.handle(IPC.ideWorkspaceOpen, (_event, repoPath: unknown) => {
    if (!worktreeManager || !safetyBoundary) {
      return { ok: false, error: 'Worktree manager is not ready.' };
    }
    const projectPath = safetyBoundary.assertProjectPath(repoPath, 'ide.workspace.open');
    return worktreeManager.openIdeWorkspace(projectPath);
  });
  ipcMain.handle(IPC.orchestrationsList, (_event, repoRoot: unknown) => {
    if (!orchestrator || !safetyBoundary) throw new Error('The orchestrator is not ready.');
    if (repoRoot !== undefined && typeof repoRoot !== 'string') throw new Error('Invalid repository path.');
    const selected = safetyBoundary.assertProjectPath(
      repoRoot ?? workspaceConfig.projectPath,
      'orchestration.list'
    );
    return orchestrator.list(selected);
  });
  ipcMain.handle(IPC.orchestrationCreate, async (_event, request: OrchestrationCreateRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request !== 'object') {
      throw new Error('The orchestrator is not ready.');
    }
    const repoPath = safetyBoundary.assertProjectPath(request.repoPath, 'orchestration.create');
    const snapshot = await orchestrator.create({ ...request, repoPath });
    dispatchControl('run.started', snapshot, {
      concurrency: snapshot.run.concurrency,
      baseBranch: snapshot.run.baseBranch
    });
    return snapshot;
  });
  ipcMain.handle(IPC.orchestrationReplan, async (_event, request: OrchestrationReplanRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.runId !== 'string') {
      throw new Error('Invalid re-plan request.');
    }
    safetyBoundary.assertRun(request.runId, 'orchestration.replan');
    const snapshot = await orchestrator.replan(request);
    dispatchControl('run.replanned', snapshot, { parentRunId: request.runId });
    return snapshot;
  });
  ipcMain.handle(IPC.orchestrationStop, async (_event, runId: unknown) => {
    if (!orchestrator || !safetyBoundary || typeof runId !== 'string') return { ok: false, error: 'Invalid orchestrator run.' };
    safetyBoundary.assertRun(runId, 'orchestration.stop');
    const result = await orchestrator.stop(runId);
    const snapshot = result.ok ? orchestrator.list().find((candidate) => candidate.run.id === runId) : undefined;
    if (snapshot) dispatchControl('run.stopped', snapshot);
    return result;
  });
  ipcMain.handle(IPC.orchestrationTaskRetry, async (_event, request: OrchestrationTaskRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.taskId !== 'string') {
      return { ok: false, error: 'Invalid orchestrator task.' };
    }
    safetyBoundary.assertTask(request.taskId, 'orchestration.task.retry');
    const result = await orchestrator.retry(request);
    const snapshot = result.ok
      ? orchestrator.list().find((candidate) => candidate.tasks.some((task) => task.id === request.taskId))
      : undefined;
    if (snapshot) dispatchControl('task.retried', snapshot, {}, request.taskId);
    return result;
  });
  ipcMain.handle(IPC.orchestrationTaskDiff, (_event, request: OrchestrationTaskRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.taskId !== 'string') throw new Error('Invalid task diff request.');
    safetyBoundary.assertTask(request.taskId, 'orchestration.task.diff');
    return orchestrator.diff(request);
  });
  ipcMain.handle(IPC.orchestrationTaskReview, async (_event, request: OrchestrationReviewRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.taskId !== 'string') throw new Error('Invalid task review request.');
    safetyBoundary.assertTask(request.taskId, 'orchestration.task.review');
    const snapshot = await orchestrator.review(request);
    dispatchControl('task.reviewed', snapshot, { decision: request.decision }, request.taskId);
    return snapshot;
  });
  ipcMain.handle(IPC.orchestrationIntegrate, async (_event, request: OrchestrationRunRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.runId !== 'string') throw new Error('Invalid integration request.');
    safetyBoundary.assertRun(request.runId, 'orchestration.integrate');
    const snapshot = await orchestrator.integrate(request);
    dispatchControl('run.integrated', snapshot, { status: snapshot.run.integrationStatus ?? 'pending' });
    return snapshot;
  });
  ipcMain.handle(IPC.orchestrationVerify, async (_event, request: OrchestrationVerifyRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.runId !== 'string') throw new Error('Invalid verification request.');
    safetyBoundary.assertRun(request.runId, 'orchestration.verify');
    const snapshot = await orchestrator.verify(request);
    dispatchControl('run.verification_requested', snapshot, { provider: request.provider ?? null });
    return snapshot;
  });
  ipcMain.handle(IPC.orchestrationCleanup, async (_event, request: OrchestrationRunRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request.runId !== 'string') throw new Error('Invalid cleanup request.');
    safetyBoundary.assertRun(request.runId, 'orchestration.cleanup');
    const snapshot = await orchestrator.cleanup(request);
    dispatchControl('run.cleaned', snapshot);
    return snapshot;
  });
  ipcMain.handle(IPC.agentSessionsList, (_event, repoRoot: unknown) => {
    if (!orchestrator || !safetyBoundary) throw new Error('The orchestrator is not ready.');
    if (repoRoot !== undefined && typeof repoRoot !== 'string') throw new Error('Invalid repository path.');
    const selected = safetyBoundary.assertProjectPath(
      repoRoot ?? workspaceConfig.projectPath,
      'agent-session.list'
    );
    return orchestrator.listAgentSessions(selected);
  });
  ipcMain.handle(IPC.agentSessionInputSubmit, async (_event, request: AgentSessionInputRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request !== 'object') {
      throw new Error('Invalid agent follow-up.');
    }
    safetyBoundary.assertAgentSession(request.sessionId, 'agent-session.input.submit');
    return orchestrator.submitAgentSessionInput(request);
  });
  ipcMain.handle(IPC.agentSessionRestart, async (_event, request: AgentSessionRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request !== 'object') {
      throw new Error('Invalid agent restart request.');
    }
    safetyBoundary.assertAgentSession(request.sessionId, 'agent-session.restart');
    return orchestrator.restartAgentSession(request);
  });
  ipcMain.handle(IPC.agentSessionStop, async (_event, request: AgentSessionRequest) => {
    if (!orchestrator || !safetyBoundary || !request || typeof request !== 'object') {
      return { ok: false, error: 'Invalid agent stop request.' };
    }
    safetyBoundary.assertAgentSession(request.sessionId, 'agent-session.stop');
    return orchestrator.stopAgentSession(request);
  });
  ipcMain.handle(IPC.activityList, (_event, request: ActivityListRequest | undefined) => {
    if (!database) throw new Error('Finish setup first.');
    if (request !== undefined && (!request || typeof request !== 'object')) {
      throw new Error('Invalid activity request.');
    }
    return database.listEvents(request);
  });
  ipcMain.handle(IPC.preferencesUpdate, (_event, request: PreferencesUpdateRequest) => {
    if (!database || !request || typeof request !== 'object') throw new Error('Finish setup first.');
    const preferences = normalizePreferences(request);
    database.setValue('preferences', preferences);
    database.appendEvent('app.preferences.updated', preferences);
    return preferences;
  });
  ipcMain.handle(IPC.diagnosticsGet, () => buildDiagnostics());
  ipcMain.handle(IPC.operationsRecover, async () => {
    if (!database || !hive || !workspaceConfig.projectPath) {
      return { ok: false, recoveredItems: 0, replayedControls: 0, missingWorktrees: 0, error: 'Finish setup first.' };
    }
    try {
      const recoveredItems = orchestrator?.recover() ?? database.recoverInterruptedOrchestrations();
      orchestrator?.reconcileRecoveredSessions();
      const health = hive.ensure();
      if (!health.ready) throw new Error(health.error ?? 'Unable to repair the hive.');
      hive.syncOrchestrations(database.listOrchestrations());
      const replayedControls = controlProtocol?.recover() ?? 0;
      await actionBridge?.flush();
      hive.recordRecovery(recoveredItems, replayedControls);
      const repository = await worktreeManager?.inspect(workspaceConfig.projectPath);
      const missingWorktrees = repository?.worktrees.filter((worktree) => worktree.status === 'missing').length ?? 0;
      database.appendEvent('app.recovery.completed', { recoveredItems, replayedControls, missingWorktrees, automatic: false });
      return { ok: true, recoveredItems, replayedControls, missingWorktrees };
    } catch (error) {
      return { ok: false, recoveredItems: 0, replayedControls: 0, missingWorktrees: 0, error: errorMessage(error) };
    }
  });
  ipcMain.handle(IPC.agentProfileSave, (_event, request: AgentProfileSaveRequest) => {
    if (!extensions) throw new Error('Finish setup first.');
    return extensions.saveProfile(request);
  });
  ipcMain.handle(IPC.agentProfileDelete, (_event, request: ExtensionDeleteRequest) => {
    if (!extensions || !request || typeof request.id !== 'string') {
      return { ok: false, error: 'Invalid agent profile.' };
    }
    return extensions.deleteProfile(request.id);
  });
  ipcMain.handle(IPC.orchestrationTemplateSave, (_event, request: OrchestrationTemplateSaveRequest) => {
    if (!extensions) throw new Error('Finish setup first.');
    return extensions.saveTemplate(request);
  });
  ipcMain.handle(IPC.orchestrationTemplateDelete, (_event, request: ExtensionDeleteRequest) => {
    if (!extensions || !request || typeof request.id !== 'string') {
      return { ok: false, error: 'Invalid template.' };
    }
    return extensions.deleteTemplate(request.id);
  });
  ipcMain.handle(IPC.terminalsList, () => ptyManager?.list() ?? []);
  ipcMain.handle(IPC.terminalSpawn, async (_event, request: TerminalSpawnRequest) => {
    if (!ptyManager || !worktreeManager || !safetyBoundary || !workspaceConfig.projectPath) {
      throw new Error('Terminal supervisor is not ready.');
    }
    const repository = await worktreeManager.inspect(safetyBoundary.selectedProject());
    if (!repository.isRepository) throw new Error(repository.error ?? 'The selected project is unavailable.');
    const allowedDirectories = repository.worktrees
      .filter((worktree) => worktree.status !== 'missing')
      .map((worktree) => worktree.path);
    const safeRequest = safetyBoundary.assertRendererTerminal(request, allowedDirectories);
    const terminal = await ptyManager.spawn(safeRequest);
    database?.appendEvent('terminal.started', {
      terminalId: terminal.id,
      provider: terminal.provider,
      role: terminal.role ?? 'worker',
      cwd: terminal.cwd
    });
    return terminal;
  });
  ipcMain.handle(IPC.terminalReplay, (_event, id: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string') throw new Error('Invalid terminal id.');
    safetyBoundary.assertRendererTerminalView(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.replay'
    );
    return ptyManager.replay(id);
  });
  ipcMain.handle(IPC.terminalWrite, (_event, id: unknown, data: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string' || typeof data !== 'string') {
      return { ok: false, error: 'Invalid terminal input.' };
    }
    safetyBoundary.assertRendererTerminalControl(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.write'
    );
    return ptyManager.write(id, data);
  });
  ipcMain.handle(IPC.terminalResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') {
      return { ok: false, error: 'Invalid terminal dimensions.' };
    }
    safetyBoundary.assertRendererTerminalView(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.resize'
    );
    return ptyManager.resize(id, cols, rows);
  });
  ipcMain.handle(IPC.terminalInterrupt, (_event, id: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    safetyBoundary.assertRendererTerminalControl(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.interrupt'
    );
    return ptyManager.interrupt(id);
  });
  ipcMain.handle(IPC.terminalStop, (_event, id: unknown, force: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    safetyBoundary.assertRendererTerminalControl(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.stop'
    );
    return ptyManager.stop(id, force === true);
  });
  ipcMain.handle(IPC.terminalDismiss, (_event, id: unknown) => {
    if (!ptyManager || !safetyBoundary || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    safetyBoundary.assertRendererTerminalControl(
      ptyManager.list().find((terminal) => terminal.id === id),
      'terminal.dismiss'
    );
    return ptyManager.dismiss(id);
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (process.platform === 'darwin' && !app.isPackaged) {
    const developmentIcon = nativeImage.createFromPath(
      resolve(process.cwd(), 'build/relay-app-icon.png')
    );
    if (!developmentIcon.isEmpty()) app.dock?.setIcon(developmentIcon);
  }

  const appData = app.getPath('userData');
  const appLogger = createAppLogger(join(appData, 'logs'));
  logger = appLogger.logger;
  relayLogPath = appLogger.logPath;
  configStore = new WorkspaceConfigStore(applicationConfigPath(appData));
  workspaceConfig = configStore.read();
  monitorProjection = new LiveMonitorProjection({
    onUpdate: (snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.orchestratorProjectionUpdate, snapshot);
      }
    }
  });
  ptyManager = new PtyManager({
    logger,
    onData: (event) => {
      orchestrator?.handleTerminalData(event);
      monitorProjection?.handleData(event);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.terminalData, event);
    },
    onExit: (event) => {
      orchestrator?.handleTerminalExit(event);
      monitorProjection?.handleExit(event);
      database?.appendEvent('terminal.finished', {
        terminalId: event.id,
        exitCode: event.exitCode,
        signal: event.signal
      });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.terminalExit, event);
    }
  });

  if (workspaceConfig.onboardingComplete && workspaceConfig.harnessHome && workspaceConfig.projectPath) {
    try {
      const restored = validateWorkspaceRequest({
        harnessHome: workspaceConfig.harnessHome,
        projectPath: workspaceConfig.projectPath,
        orchestratorProvider: workspaceConfig.orchestratorProvider,
        orchestratorModel: workspaceConfig.orchestratorModel
      }, workspaceConfig.orchestratorName);
      workspaceConfig = restored;
    } catch (error) {
      logger.error({ error }, 'Failed to restore the Relay workspace');
      workspaceConfig = { ...EMPTY_WORKSPACE };
    }
  }

  registerIpcHandlers();
  mainWindow = createWindow();
  logger.info({
    logPath: appLogger.logPath,
    configured: workspaceConfig.onboardingComplete,
    harnessHome: workspaceConfig.harnessHome,
    projectPath: workspaceConfig.projectPath
  }, 'Relay started');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  orchestrator?.shutdown();
  actionBridge?.stop();
  monitorProjection?.dispose();
  ptyManager?.stopAll();
  ptyManager = null;
  controlProtocol = null;
  actionBridge = null;
  monitorProjection = null;
  safetyBoundary = null;
  orchestrator = null;
  hive = null;
  worktreeManager = null;
  extensions = null;
  database?.appendEvent('app.stopping', {});
  database?.close();
  database = null;
  configStore = null;
  logger = null;
  mainWindow = null;
});
