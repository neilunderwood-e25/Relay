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

export interface HiveCoordinationMessage {
  id: string;
  runId: string;
  taskId?: string;
  from: string;
  to: 'orchestrator';
  kind: 'status' | 'blocker' | 'result' | 'replan' | 'summary';
  body: string;
  createdAt: number;
}

export type RelayControlKind =
  | 'input.submitted'
  | 'action.completed'
  | 'action.rejected'
  | 'run.started'
  | 'run.completed'
  | 'run.blocked'
  | 'run.failed'
  | 'run.replanned'
  | 'run.stopped'
  | 'task.retried'
  | 'task.reviewed'
  | 'run.integrated'
  | 'run.verification_requested'
  | 'run.verified'
  | 'run.cleaned';

export interface RelayControlCommand {
  version: 1;
  id: string;
  kind: RelayControlKind;
  actor: 'human' | 'relay';
  createdAt: number;
  projectPath: string;
  runId: string;
  taskId?: string;
  objective: string;
  strategy: OrchestrationStrategy;
  payload: Record<string, string | number | boolean | null>;
}

export interface OrchestratorInputRequest {
  text: string;
  strategy: OrchestrationStrategy;
  providers: ProviderId[];
  concurrency: number;
  profileIds?: string[];
  templateId?: string;
}

export interface OrchestratorInputReceipt {
  id: string;
  status: 'queued';
  submittedAt: number;
}

export type OrchestratorProjectionStatus = 'starting' | 'ready' | 'working' | 'stopped' | 'error';
export type OrchestratorProjectionEventKind = 'input' | 'action' | 'run' | 'system';

export interface OrchestratorProjectionEvent {
  id: string;
  kind: OrchestratorProjectionEventKind;
  label: string;
  createdAt: number;
}

export interface OrchestratorProjectionSnapshot {
  terminalId: string | null;
  status: OrchestratorProjectionStatus;
  updatedAt: number;
  lastSequence: number;
  lines: string[];
  events: OrchestratorProjectionEvent[];
}

export type OrchestratorActionKind =
  | 'run.create'
  | 'run.stop'
  | 'run.replan'
  | 'task.retry'
  | 'task.review'
  | 'run.integrate'
  | 'run.verify'
  | 'run.cleanup';

/** An untrusted, allowlisted request written by Michael for Relay main to execute. */
export interface OrchestratorActionRequest {
  version: 1;
  id: string;
  kind: OrchestratorActionKind;
  createdAt: number;
  inputId?: string;
  runId?: string;
  taskId?: string;
  objective?: string;
  strategy?: OrchestrationStrategy;
  providers?: ProviderId[];
  concurrency?: number;
  profileIds?: string[];
  templateId?: string;
  decision?: 'accepted' | 'rejected';
  provider?: ProviderId;
}

export interface OrchestratorActionResult {
  version: 1;
  actionId: string;
  kind: OrchestratorActionKind | 'unknown';
  status: 'completed' | 'rejected';
  completedAt: number;
  runId?: string;
  taskId?: string;
  summary?: string;
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

export interface AgentProfile {
  id: string;
  name: string;
  provider: ProviderId;
  model: string | null;
  instructions: string;
  avatarSeed: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfileSaveRequest {
  id?: string;
  name: string;
  provider: ProviderId;
  model?: string | null;
  instructions?: string;
  avatarSeed?: string;
  enabled?: boolean;
}

export interface OrchestrationTemplate {
  id: string;
  name: string;
  objective: string;
  strategy: OrchestrationStrategy;
  profileIds: string[];
  concurrency: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrchestrationTemplateSaveRequest {
  id?: string;
  name: string;
  objective: string;
  strategy: OrchestrationStrategy;
  profileIds?: string[];
  concurrency?: number;
}

export interface ExtensionDeleteRequest {
  id: string;
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
  agentProfiles: AgentProfile[];
  orchestrationTemplates: OrchestrationTemplate[];
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
  replayedControls: number;
  missingWorktrees: number;
  error?: string;
}

export type TerminalStatus = 'starting' | 'running' | 'stopping' | 'exited';
export type TerminalRole = 'worker' | 'orchestrator' | 'planner' | 'synthesizer' | 'verifier';
export type TerminalOutputMode = 'terminal' | 'event-stream';

export interface TerminalSpawnRequest {
  provider: ProviderId;
  role?: TerminalRole;
  avatarSeed?: string;
  name?: string;
  cwd: string;
  cols?: number;
  rows?: number;
  args?: string[];
  outputMode?: TerminalOutputMode;
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
  outputMode?: TerminalOutputMode;
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

export type IdeId = 'cursor' | 'vscode';

export interface IdeWorkspaceOpenResult extends OperationResult {
  ide?: IdeId;
  workspacePath?: string;
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
  repoPath?: string;
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
  | 'planning'
  | 'queued'
  | 'running'
  | 'summarizing'
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
export type PlanningSource = 'model' | 'fallback';
export type SynthesisStatus = 'idle' | 'running' | 'completed' | 'fallback';

export type AgentSessionStatus =
  | 'starting'
  | 'working'
  | 'idle'
  | 'stopping'
  | 'stopped'
  | 'resumable'
  | 'failed'
  | 'closed';

/**
 * Durable identity for a worker conversation. The PTY is intentionally only one
 * attachment to the session: later milestones can stop or replace that process
 * without losing the provider conversation or its worktree association.
 */
export interface AgentSession {
  id: string;
  runId: string;
  initialTaskId: string;
  provider: ProviderId;
  status: AgentSessionStatus;
  worktreeId?: string;
  worktreePath?: string;
  branch?: string;
  terminalId?: string;
  nativeSessionId?: string;
  profileId?: string;
  agentName: string;
  avatarSeed: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  lastActiveAt?: number;
  stoppedAt?: number;
  error?: string;
}

export interface AgentSessionRequest {
  sessionId: string;
}

export interface AgentSessionInputRequest extends AgentSessionRequest {
  prompt: string;
}

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
  templateId?: string;
  planningProvider?: ProviderId;
  planningModel?: string;
  planningTerminalId?: string;
  planningSummary?: string;
  planningError?: string;
  planningSource?: PlanningSource;
  planningProviders?: ProviderId[];
  planningProfileIds?: string[];
  parentRunId?: string;
  replanContext?: string;
  synthesisStatus?: SynthesisStatus;
  synthesisProvider?: ProviderId;
  synthesisModel?: string;
  synthesisTerminalId?: string;
  finalSummary?: string;
  synthesisError?: string;
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
  agentSessionId?: string;
  summary?: string;
  error?: string;
  blocker?: string;
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
  profileId?: string;
  agentName?: string;
  avatarSeed?: string;
  model?: string;
  profileInstructions?: string;
}

export interface OrchestrationSnapshot {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  /** Optional for compatibility with snapshots written before agent sessions existed. */
  sessions?: AgentSession[];
}

export interface OrchestrationCreateRequest {
  repoPath: string;
  objective: string;
  strategy?: OrchestrationStrategy;
  baseBranch?: string;
  providers?: ProviderId[];
  concurrency?: number;
  profileIds?: string[];
  templateId?: string;
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

export interface OrchestrationReplanRequest extends OrchestrationRunRequest {}

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
  /** Stable identity for the complete diff, including content omitted from patch. */
  fingerprint?: string;
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
  ensureOrchestratorSession(): Promise<TerminalSnapshot>;
  submitOrchestratorInput(request: OrchestratorInputRequest): Promise<OrchestratorInputReceipt>;
  getOrchestratorProjection(): Promise<OrchestratorProjectionSnapshot>;
  inspectRepository(directory: string): Promise<RepositorySnapshot>;
  createWorktree(request: WorktreeCreateRequest): Promise<WorktreeSnapshot>;
  removeWorktree(request: WorktreeRemoveRequest): Promise<OperationResult>;
  openIdeWorkspace(repoPath: string): Promise<IdeWorkspaceOpenResult>;
  listOrchestrations(repoRoot?: string): Promise<OrchestrationSnapshot[]>;
  createOrchestration(request: OrchestrationCreateRequest): Promise<OrchestrationSnapshot>;
  replanOrchestration(request: OrchestrationReplanRequest): Promise<OrchestrationSnapshot>;
  stopOrchestration(runId: string): Promise<OperationResult>;
  retryOrchestrationTask(request: OrchestrationTaskRequest): Promise<OperationResult>;
  getOrchestrationTaskDiff(request: OrchestrationTaskRequest): Promise<TaskDiffSnapshot>;
  reviewOrchestrationTask(request: OrchestrationReviewRequest): Promise<OrchestrationSnapshot>;
  integrateOrchestration(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot>;
  verifyOrchestration(request: OrchestrationVerifyRequest): Promise<OrchestrationSnapshot>;
  cleanupOrchestration(request: OrchestrationRunRequest): Promise<OrchestrationSnapshot>;
  listAgentSessions(repoRoot?: string): Promise<AgentSession[]>;
  submitAgentSessionInput(request: AgentSessionInputRequest): Promise<AgentSession>;
  restartAgentSession(request: AgentSessionRequest): Promise<AgentSession>;
  stopAgentSession(request: AgentSessionRequest): Promise<OperationResult>;
  listActivity(request?: ActivityListRequest): Promise<ActivityPage>;
  updatePreferences(request: PreferencesUpdateRequest): Promise<RelayPreferences>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
  recoverOperations(): Promise<RecoveryResult>;
  saveAgentProfile(request: AgentProfileSaveRequest): Promise<AgentProfile>;
  deleteAgentProfile(request: ExtensionDeleteRequest): Promise<OperationResult>;
  saveOrchestrationTemplate(request: OrchestrationTemplateSaveRequest): Promise<OrchestrationTemplate>;
  deleteOrchestrationTemplate(request: ExtensionDeleteRequest): Promise<OperationResult>;
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
  onOrchestratorProjection(listener: (snapshot: OrchestratorProjectionSnapshot) => void): Unsubscribe;
}
