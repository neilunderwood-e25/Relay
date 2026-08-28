import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { Logger } from 'pino';
import type {
  AppSnapshot,
  OrchestratorRenameRequest,
  OrchestrationCreateRequest,
  OrchestrationTaskRequest,
  TerminalSpawnRequest,
  WorkspaceConfig,
  WorkspaceConfigureRequest,
  WorktreeCreateRequest,
  WorktreeRemoveRequest
} from '../shared/contracts';
import { DEFAULT_ORCHESTRATOR_NAME, PROVIDER_IDS, type ProviderId } from '../shared/contracts';
import { IPC } from '../shared/ipc';
import {
  DEFAULT_ORCHESTRATOR_PROVIDER,
  isOrchestratorModel
} from '../shared/orchestratorModels';
import { WorkspaceConfigStore } from './config';
import { RelayDatabase } from './database';
import { HiveManager } from './hive';
import { createAppLogger } from './logger';
import { RehanOrchestrator } from './orchestrator';
import { detectProviders } from './providers';
import { PtyManager } from './pty';
import { WorktreeManager } from './worktrees';

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
let configStore: WorkspaceConfigStore | null = null;
let workspaceConfig: WorkspaceConfig = { ...EMPTY_WORKSPACE };
let database: RelayDatabase | null = null;
let hive: HiveManager | null = null;
let ptyManager: PtyManager | null = null;
let worktreeManager: WorktreeManager | null = null;
let rehan: RehanOrchestrator | null = null;

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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
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
    providers: await detectProviders()
  };
}

function bootstrapWorkspace(config: WorkspaceConfig): void {
  if (database && hive && worktreeManager && rehan) return;
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
    mkdirSync(join(harnessHome, 'worktrees'), { recursive: true });

    const nextWorktrees = new WorktreeManager({
      database: nextDatabase,
      logger,
      storageRoot: join(harnessHome, 'worktrees')
    });
    const nextRehan = new RehanOrchestrator({
      database: nextDatabase,
      logger,
      worktrees: nextWorktrees,
      terminals: ptyManager,
      detectProviders,
      getOrchestratorName: () => workspaceConfig.orchestratorName,
      onUpdate: (snapshot) => {
        nextHive.syncOrchestrations(nextDatabase.listOrchestrations());
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.orchestrationUpdate, snapshot);
        }
      }
    });

    nextRehan.recover();
    nextHive.syncOrchestrations(nextDatabase.listOrchestrations());
    nextDatabase.appendEvent('app.started', {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch
    });
    database = nextDatabase;
    hive = nextHive;
    worktreeManager = nextWorktrees;
    rehan = nextRehan;
  } catch (error) {
    nextDatabase.close();
    throw error;
  }
}

function validateWorkspace(request: WorkspaceConfigureRequest): WorkspaceConfig {
  if (!request || typeof request.harnessHome !== 'string' || typeof request.projectPath !== 'string') {
    throw new Error('Choose a Harness Home and Git project.');
  }

  const orchestratorProvider = request.orchestratorProvider;
  if (!PROVIDER_IDS.includes(orchestratorProvider as ProviderId)) {
    throw new Error('Choose an orchestrator engine.');
  }
  if (!isOrchestratorModel(orchestratorProvider, request.orchestratorModel)) {
    throw new Error('Choose a supported orchestrator model.');
  }

  const requestedHome = request.harnessHome.trim();
  const requestedProject = request.projectPath.trim();
  if (!requestedHome || !requestedProject || !isAbsolute(requestedHome) || !isAbsolute(requestedProject)) {
    throw new Error('Choose absolute folders for the Harness Home and project.');
  }

  mkdirSync(requestedHome, { recursive: true });
  if (!statSync(requestedHome).isDirectory()) throw new Error('Harness Home must be a folder.');
  if (!existsSync(requestedProject) || !statSync(requestedProject).isDirectory()) {
    throw new Error('The project folder was not found.');
  }

  const harnessHome = realpathSync(requestedHome);
  const selectedProject = realpathSync(requestedProject);
  const git = spawnSync('git', ['-C', selectedProject, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 10_000
  });
  if (git.status !== 0 || !git.stdout.trim()) throw new Error('Choose a Git repository.');
  const projectPath = realpathSync(resolve(git.stdout.trim()));

  if (harnessHome === projectPath || isNestedPath(projectPath, harnessHome)) {
    throw new Error('Choose a Harness Home outside the project.');
  }

  return {
    onboardingComplete: true,
    harnessHome,
    projectPath,
    orchestratorName: workspaceConfig.orchestratorName || DEFAULT_ORCHESTRATOR_NAME,
    orchestratorProvider,
    orchestratorModel: request.orchestratorModel
  };
}

function isNestedPath(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return nested.length > 0 && !nested.startsWith('..') && !isAbsolute(nested);
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
  ipcMain.handle(IPC.providersRefresh, () => detectProviders());
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
    const nextConfig = validateWorkspace(request);
    if (database && workspaceConfig.harnessHome !== nextConfig.harnessHome) {
      throw new Error('Restart Relay to change the Harness Home.');
    }
    const provider = (await detectProviders()).find(({ id }) => id === nextConfig.orchestratorProvider);
    if (!provider?.available) {
      throw new Error(`${provider?.label ?? nextConfig.orchestratorProvider} is not available.`);
    }
    const previousConfig = workspaceConfig;
    workspaceConfig = nextConfig;
    try {
      bootstrapWorkspace(nextConfig);
      workspaceConfig = configStore?.write(nextConfig) ?? nextConfig;
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
    return buildAppSnapshot();
  });
  ipcMain.handle(IPC.repositoryInspect, (_event, directory: unknown) => {
    if (!worktreeManager || typeof directory !== 'string') throw new Error('Invalid repository path.');
    return worktreeManager.inspect(directory);
  });
  ipcMain.handle(IPC.worktreeCreate, (_event, request: WorktreeCreateRequest) => {
    if (!worktreeManager) throw new Error('Worktree manager is not ready.');
    return worktreeManager.create(request);
  });
  ipcMain.handle(IPC.worktreeRemove, (_event, request: WorktreeRemoveRequest) => {
    if (!worktreeManager || !database || !request || typeof request.id !== 'string') {
      return { ok: false, error: 'Invalid worktree request.' };
    }
    const record = database.getWorktree(request.id);
    const inUse = record && ptyManager?.list().some((terminal) =>
      terminal.status !== 'exited' && resolve(terminal.cwd) === resolve(record.path)
    );
    if (inUse) return { ok: false, error: 'Stop the worktree terminal first.' };
    return worktreeManager.remove(request);
  });
  ipcMain.handle(IPC.orchestrationsList, (_event, repoRoot: unknown) => {
    if (!rehan) throw new Error('The orchestrator is not ready.');
    if (repoRoot !== undefined && typeof repoRoot !== 'string') throw new Error('Invalid repository path.');
    return rehan.list(repoRoot as string | undefined);
  });
  ipcMain.handle(IPC.orchestrationCreate, (_event, request: OrchestrationCreateRequest) => {
    if (!rehan) throw new Error('The orchestrator is not ready.');
    return rehan.create(request);
  });
  ipcMain.handle(IPC.orchestrationStop, (_event, runId: unknown) => {
    if (!rehan || typeof runId !== 'string') return { ok: false, error: 'Invalid orchestrator run.' };
    return rehan.stop(runId);
  });
  ipcMain.handle(IPC.orchestrationTaskRetry, (_event, request: OrchestrationTaskRequest) => {
    if (!rehan || !request || typeof request.taskId !== 'string') {
      return { ok: false, error: 'Invalid orchestrator task.' };
    }
    return rehan.retry(request);
  });
  ipcMain.handle(IPC.terminalsList, () => ptyManager?.list() ?? []);
  ipcMain.handle(IPC.terminalSpawn, (_event, request: TerminalSpawnRequest) => {
    if (!ptyManager) throw new Error('Terminal supervisor is not ready.');
    return ptyManager.spawn(request);
  });
  ipcMain.handle(IPC.terminalReplay, (_event, id: unknown) => {
    if (!ptyManager || typeof id !== 'string') throw new Error('Invalid terminal id.');
    return ptyManager.replay(id);
  });
  ipcMain.handle(IPC.terminalWrite, (_event, id: unknown, data: unknown) => {
    if (!ptyManager || typeof id !== 'string' || typeof data !== 'string') {
      return { ok: false, error: 'Invalid terminal input.' };
    }
    return ptyManager.write(id, data);
  });
  ipcMain.handle(IPC.terminalResize, (_event, id: unknown, cols: unknown, rows: unknown) => {
    if (!ptyManager || typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') {
      return { ok: false, error: 'Invalid terminal dimensions.' };
    }
    return ptyManager.resize(id, cols, rows);
  });
  ipcMain.handle(IPC.terminalInterrupt, (_event, id: unknown) => {
    if (!ptyManager || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    return ptyManager.interrupt(id);
  });
  ipcMain.handle(IPC.terminalStop, (_event, id: unknown, force: unknown) => {
    if (!ptyManager || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    return ptyManager.stop(id, force === true);
  });
  ipcMain.handle(IPC.terminalDismiss, (_event, id: unknown) => {
    if (!ptyManager || typeof id !== 'string') return { ok: false, error: 'Invalid terminal id.' };
    return ptyManager.dismiss(id);
  });
}

app.whenReady().then(() => {
  const appData = app.getPath('userData');
  const appLogger = createAppLogger(join(appData, 'logs'));
  logger = appLogger.logger;
  configStore = new WorkspaceConfigStore(applicationConfigPath(appData));
  workspaceConfig = configStore.read();
  ptyManager = new PtyManager({
    logger,
    onData: (event) => {
      rehan?.handleTerminalData(event);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.terminalData, event);
    },
    onExit: (event) => {
      rehan?.handleTerminalExit(event);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.terminalExit, event);
    }
  });

  if (workspaceConfig.onboardingComplete && workspaceConfig.harnessHome && workspaceConfig.projectPath) {
    try {
      const restored = validateWorkspace({
        harnessHome: workspaceConfig.harnessHome,
        projectPath: workspaceConfig.projectPath,
        orchestratorProvider: workspaceConfig.orchestratorProvider,
        orchestratorModel: workspaceConfig.orchestratorModel
      });
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
  ptyManager?.stopAll();
  ptyManager = null;
  rehan = null;
  hive = null;
  worktreeManager = null;
  database?.appendEvent('app.stopping', {});
  database?.close();
  database = null;
  configStore = null;
  logger = null;
  mainWindow = null;
});
