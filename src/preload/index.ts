import { contextBridge, ipcRenderer } from 'electron';
import type {
  RelayApi,
  OrchestratorProjectionSnapshot,
  OrchestrationSnapshot,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/contracts';
import { IPC } from '../shared/ipc';

const api: RelayApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.appSnapshot),
  refreshProviders: () => ipcRenderer.invoke(IPC.providersRefresh),
  chooseDirectory: (purpose) => ipcRenderer.invoke(IPC.chooseDirectory, purpose),
  configureWorkspace: (request) => ipcRenderer.invoke(IPC.workspaceConfigure, request),
  renameOrchestrator: (request) => ipcRenderer.invoke(IPC.orchestratorRename, request),
  ensureOrchestratorSession: () => ipcRenderer.invoke(IPC.orchestratorSessionEnsure),
  submitOrchestratorInput: (request) => ipcRenderer.invoke(IPC.orchestratorInputSubmit, request),
  getOrchestratorProjection: () => ipcRenderer.invoke(IPC.orchestratorProjectionGet),
  inspectRepository: (directory) => ipcRenderer.invoke(IPC.repositoryInspect, directory),
  createWorktree: (request) => ipcRenderer.invoke(IPC.worktreeCreate, request),
  removeWorktree: (request) => ipcRenderer.invoke(IPC.worktreeRemove, request),
  listOrchestrations: (repoRoot) => ipcRenderer.invoke(IPC.orchestrationsList, repoRoot),
  createOrchestration: (request) => ipcRenderer.invoke(IPC.orchestrationCreate, request),
  replanOrchestration: (request) => ipcRenderer.invoke(IPC.orchestrationReplan, request),
  stopOrchestration: (runId) => ipcRenderer.invoke(IPC.orchestrationStop, runId),
  retryOrchestrationTask: (request) => ipcRenderer.invoke(IPC.orchestrationTaskRetry, request),
  getOrchestrationTaskDiff: (request) => ipcRenderer.invoke(IPC.orchestrationTaskDiff, request),
  reviewOrchestrationTask: (request) => ipcRenderer.invoke(IPC.orchestrationTaskReview, request),
  integrateOrchestration: (request) => ipcRenderer.invoke(IPC.orchestrationIntegrate, request),
  verifyOrchestration: (request) => ipcRenderer.invoke(IPC.orchestrationVerify, request),
  cleanupOrchestration: (request) => ipcRenderer.invoke(IPC.orchestrationCleanup, request),
  listActivity: (request) => ipcRenderer.invoke(IPC.activityList, request),
  updatePreferences: (request) => ipcRenderer.invoke(IPC.preferencesUpdate, request),
  getDiagnostics: () => ipcRenderer.invoke(IPC.diagnosticsGet),
  recoverOperations: () => ipcRenderer.invoke(IPC.operationsRecover),
  saveAgentProfile: (request) => ipcRenderer.invoke(IPC.agentProfileSave, request),
  deleteAgentProfile: (request) => ipcRenderer.invoke(IPC.agentProfileDelete, request),
  saveOrchestrationTemplate: (request) => ipcRenderer.invoke(IPC.orchestrationTemplateSave, request),
  deleteOrchestrationTemplate: (request) => ipcRenderer.invoke(IPC.orchestrationTemplateDelete, request),
  listTerminals: () => ipcRenderer.invoke(IPC.terminalsList),
  spawnTerminal: (request) => ipcRenderer.invoke(IPC.terminalSpawn, request),
  getTerminalReplay: (id) => ipcRenderer.invoke(IPC.terminalReplay, id),
  writeTerminal: (id, data) => ipcRenderer.invoke(IPC.terminalWrite, id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.invoke(IPC.terminalResize, id, cols, rows),
  interruptTerminal: (id) => ipcRenderer.invoke(IPC.terminalInterrupt, id),
  stopTerminal: (id, force) => ipcRenderer.invoke(IPC.terminalStop, id, force),
  dismissTerminal: (id) => ipcRenderer.invoke(IPC.terminalDismiss, id),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload);
    ipcRenderer.on(IPC.terminalData, handler);
    return () => ipcRenderer.removeListener(IPC.terminalData, handler);
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TerminalExitEvent): void => listener(payload);
    ipcRenderer.on(IPC.terminalExit, handler);
    return () => ipcRenderer.removeListener(IPC.terminalExit, handler);
  },
  onOrchestrationUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OrchestrationSnapshot): void => listener(payload);
    ipcRenderer.on(IPC.orchestrationUpdate, handler);
    return () => ipcRenderer.removeListener(IPC.orchestrationUpdate, handler);
  },
  onOrchestratorProjection: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OrchestratorProjectionSnapshot): void => listener(payload);
    ipcRenderer.on(IPC.orchestratorProjectionUpdate, handler);
    return () => ipcRenderer.removeListener(IPC.orchestratorProjectionUpdate, handler);
  }
};

contextBridge.exposeInMainWorld('relay', api);
