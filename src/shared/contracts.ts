export const PROVIDER_IDS = ['claude', 'codex'] as const;
export const DEFAULT_ORCHESTRATOR_NAME = 'Michael';

export const DEFAULT_AGENT_NAMES = {
  claude: 'Claude',
  codex: 'Codex'
} as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderCapability {
  id: ProviderId;
  label: string;
  command: string;
  available: boolean;
  executablePath: string | null;
  version: string | null;
  error: string | null;
}

export interface DatabaseHealth {
  open: boolean;
  path: string;
  schemaVersion: number;
}

export interface HiveHealth {
  ready: boolean;
  path: string;
  agentPath: string;
  error?: string;
}

export interface WorkspaceConfig {
  onboardingComplete: boolean;
  harnessHome: string | null;
  projectPath: string | null;
  orchestratorName: string;
  orchestratorProvider: ProviderId;
  orchestratorModel: string | null;
}

export interface RelayPreferences {
  defaultStrategy: OrchestrationStrategy;
  maxConcurrentAgents: number;
  verificationProvider: ProviderId | null;
}

export const DEFAULT_RELAY_PREFERENCES: RelayPreferences = {
  defaultStrategy: 'balanced',
  maxConcurrentAgents: 2,
  verificationProvider: null
};

export interface AppSnapshot {
  appName: string;
  appVersion: string;
  platform: string;
  arch: string;
  defaultWorkingDirectory: string;
  database: DatabaseHealth;
  hive: HiveHealth;
  workspace: WorkspaceConfig;
  preferences: RelayPreferences;
  providers: ProviderCapability[];
}

export type ActivityCategory = 'all' | 'orchestration' | 'worktree' | 'terminal' | 'system';

export interface ActivityEvent {
  id: number;
  occurredAt: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ActivityListRequest {
  category?: ActivityCategory;
  beforeId?: number;
  limit?: number;
}

export interface ActivityPage {
  events: ActivityEvent[];
  hasMore: boolean;
  nextBeforeId?: number;
}

export interface PreferencesUpdateRequest {
  defaultStrategy: OrchestrationStrategy;
  maxConcurrentAgents: number;
  verificationProvider: ProviderId | null;
}

export interface RuntimeDiagnostics {
  uptimeMs: number;
  activeTerminals: number;
  runningOrchestrations: number;
  managedWorktrees: number;
  missingWorktrees: number;
  activityEvents: number;
  databasePath: string;
  hivePath: string;
  logPath: string;
}

export interface RecoveryResult {
  ok: boolean;
  recoveredItems: number;
  missingWorktrees: number;
  error?: string;
}

export type TerminalStatus = 'starting' | 'running' | 'stopping' | 'exited';
export type TerminalRole = 'worker' | 'orchestrator';

export interface TerminalSpawnRequest {
  provider: ProviderId;
  role?: TerminalRole;
  avatarSeed?: string;
  name?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  args?: string[];
}

export interface TerminalSnapshot {
  id: string;
  role?: TerminalRole;
  avatarSeed?: string;
  name: string;
  provider: ProviderId;
  command: string;
  cwd: string;
  pid: number;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: number;
  lastOutputAt: number;
  hasOutput: boolean;
  lastSequence: number;
  exitCode?: number;
  exitSignal?: number;
  exitedAt?: number;
}

export interface TerminalDataEvent {
  id: string;
  data: string;
  sequence: number;
}

export interface TerminalExitEvent {
  id: string;
  exitCode: number;
  signal?: number;
  exitedAt: number;
}

export interface TerminalReplay {
  data: string;
  lastSequence: number;
}

export interface OperationResult {
  ok: boolean;
  error?: string;
}

export interface WorktreeRecord {
  id: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  createdAt: number;
  updatedAt: number;
}

export type WorktreeStatus = 'ready' | 'dirty' | 'missing' | 'locked';

export interface WorktreeSnapshot extends WorktreeRecord {
  head: string;
  managed: boolean;
  isMain: boolean;
  dirty: boolean;
  ahead: number;
  status: WorktreeStatus;
}

export interface RepositorySnapshot {
  directory: string;
  isRepository: boolean;
  root: string | null;
  mainRoot: string | null;
  name: string;
  currentBranch: string | null;
  branches: string[];
  worktrees: WorktreeSnapshot[];
  error?: string;
}

export interface WorktreeCreateRequest {
  repoPath: string;
  name: string;
  baseBranch?: string;
}

export interface WorktreeRemoveRequest {
  id: string;
  force?: boolean;
}

export interface WorkspaceConfigureRequest {
  harnessHome: string;
  projectPath: string;
  orchestratorProvider: ProviderId;
  orchestratorModel: string | null;
}

export interface OrchestratorRenameRequest {
  name: string;
}

export type OrchestrationRunStatus =
  | 'queued'
  | 'running'
  | 'stopping'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped';

export const ORCHESTRATION_STRATEGIES = ['balanced', 'parallel', 'audit'] as const;
export type OrchestrationStrategy = (typeof ORCHESTRATION_STRATEGIES)[number];
export type OrchestrationTaskRole = 'owner' | 'builder' | 'specialist' | 'reviewer' | 'investigator';

export type OrchestrationTaskStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'stopped';

export type OrchestrationReviewStatus = 'pending' | 'accepted' | 'rejected';
export type TaskIntegrationStatus = 'pending' | 'integrating' | 'integrated' | 'no_changes' | 'conflict' | 'failed';
export type RunIntegrationStatus = 'pending' | 'reviewing' | 'integrating' | 'integrated' | 'conflict' | 'failed';
export type VerificationStatus = 'idle' | 'running' | 'passed' | 'failed';

export interface OrchestrationRun {
  id: string;
  objective: string;
  repoRoot: string;
  baseBranch: string;
  status: OrchestrationRunStatus;
  strategy: OrchestrationStrategy;
  concurrency: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  integrationStatus?: RunIntegrationStatus;
  integrationError?: string;
  verificationStatus?: VerificationStatus;
  verificationProvider?: ProviderId;
  verificationTerminalId?: string;
  verificationSummary?: string;
  verificationError?: string;
}

export interface OrchestrationTask {
  id: string;
  runId: string;
  ordinal: number;
  title: string;
  instructions: string;
  role: OrchestrationTaskRole;
  deliverable: string;
  provider: ProviderId;
  status: OrchestrationTaskStatus;
  attempt: number;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  terminalId?: string;
  summary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  reviewStatus?: OrchestrationReviewStatus;
  integrationStatus?: TaskIntegrationStatus;
  integrationCommit?: string;
  integrationError?: string;
  reviewedAt?: number;
  integratedAt?: number;
}

export interface OrchestrationSnapshot {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
}

export interface OrchestrationCreateRequest {
  repoPath: string;
  objective: string;
  strategy?: OrchestrationStrategy;
  baseBranch?: string;
  providers?: ProviderId[];
  concurrency?: number;
}

export interface OrchestrationTaskRequest {
  taskId: string;
}

export interface OrchestrationReviewRequest extends OrchestrationTaskRequest {
  decision: Exclude<OrchestrationReviewStatus, 'pending'>;
}

export interface OrchestrationRunRequest {
  runId: string;
}

export interface OrchestrationVerifyRequest extends OrchestrationRunRequest {
  provider?: ProviderId;
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'unknown';

export interface TaskDiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

export interface TaskDiffSnapshot {
  taskId: string;
  branch: string;
  baseBranch: string;
  files: TaskDiffFile[];
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
}

export interface WorktreeIntegrationResult {
  status: 'integrated' | 'no_changes' | 'conflict';
  commit?: string;
  conflicts?: string[];
  error?: string;
}

export type Unsubscribe = () => void;

export interface RelayApi {
  getSnapshot(): Promise<AppSnapshot>;
  refreshProviders(): Promise<ProviderCapability[]>;
  chooseDirectory(purpose?: 'home' | 'project'): Promise<string | null>;
  configureWorkspace(request: WorkspaceConfigureRequest): Promise<AppSnapshot>;
  renameOrchestrator(request: OrchestratorRenameRequest): Promise<AppSnapshot>;
  inspectRepository(directory: string): Promise<RepositorySnapshot>;
  createWorktree(request: WorktreeCreateRequest): Promise<WorktreeSnapshot>;
  removeWorktree(request: WorktreeRemoveRequest): Promise<OperationResult>;
  listOrchestrations(repoRoot?: string): Promise<OrchestrationSnapshot[]>;
  createOrchestration(request: OrchestrationCreateRequest): Promise<OrchestrationSnapshot>;
  stopOrchestration(runId: string): Promise<OperationResult>;
  retryOrchestrationTask(request: OrchestrationTaskRequest): Promise<OperationResult>;
  getOrchestrationTaskDiff(request: OrchestrationTaskRequest): Promise<TaskDiffSnapshot>;
  reviewOrchestrationTask(request: OrchestrationReviewRequest): Promise<OrchestrationSnapshot>;
  integrateOrchestration(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot>;
  verifyOrchestration(request: OrchestrationVerifyRequest): Promise<OrchestrationSnapshot>;
  cleanupOrchestration(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot>;
  listActivity(request?: ActivityListRequest): Promise<ActivityPage>;
  updatePreferences(request: PreferencesUpdateRequest): Promise<RelayPreferences>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  recoverOperations(): Promise<RecoveryResult>;
  listTerminals(): Promise<TerminalSnapshot[]>;
  spawnTerminal(request: TerminalSpawnRequest): Promise<TerminalSnapshot>;
  getTerminalReplay(id: string): Promise<TerminalReplay>;
  writeTerminal(id: string, data: string): Promise<OperationResult>;
  resizeTerminal(id: string, cols: number, rows: number): Promise<OperationResult>;
  interruptTerminal(id: string): Promise<OperationResult>;
  stopTerminal(id: string, force?: boolean): Promise<OperationResult>;
  dismissTerminal(id: string): Promise<OperationResult>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  onOrchestrationUpdate(listener: (snapshot: OrchestrationSnapshot) => void): Unsubscribe;
}
