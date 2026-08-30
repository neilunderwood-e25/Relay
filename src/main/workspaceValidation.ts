import { constants, accessSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path';
import {
  DEFAULT_ORCHESTRATOR_NAME,
  PROVIDER_IDS,
  type ProviderId,
  type WorkspaceConfig,
  type WorkspaceConfigureRequest
} from '../shared/contracts';
import { isOrchestratorModel } from '../shared/orchestratorModels';

const GIT_TIMEOUT_MS = 10_000;

export function validateWorkspaceRequest(
  request: WorkspaceConfigureRequest,
  orchestratorName = DEFAULT_ORCHESTRATOR_NAME
): WorkspaceConfig {
  if (!request || typeof request.harnessHome !== 'string' || typeof request.projectPath !== 'string') {
    throw new Error('Choose a Harness Home and Git project.');
  }
  const orchestratorProvider = request.orchestratorProvider;
  if (!PROVIDER_IDS.includes(orchestratorProvider as ProviderId)) throw new Error('Choose an orchestrator engine.');
  if (!isOrchestratorModel(orchestratorProvider, request.orchestratorModel)) {
    throw new Error('Choose a supported orchestrator model.');
  }

  const requestedHome = request.harnessHome.trim();
  const requestedProject = request.projectPath.trim();
  if (!requestedHome || !requestedProject || !isAbsolute(requestedHome) || !isAbsolute(requestedProject)) {
    throw new Error('Choose absolute folders for the Harness Home and project.');
  }
  if (isFilesystemRoot(requestedHome)) throw new Error('Harness Home cannot be a filesystem root.');

  try {
    mkdirSync(requestedHome, { recursive: true });
  } catch {
    throw new Error('Relay could not create the Harness Home.');
  }
  if (!statSync(requestedHome).isDirectory()) throw new Error('Harness Home must be a folder.');
  try {
    accessSync(requestedHome, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('Harness Home must be readable and writable.');
  }
  if (!existsSync(requestedProject) || !statSync(requestedProject).isDirectory()) {
    throw new Error('The project folder was not found.');
  }

  const harnessHome = realpathSync(requestedHome);
  const selectedProject = realpathSync(requestedProject);
  const git = spawnSync('git', ['-C', selectedProject, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 128 * 1024
  });
  if (git.error && 'code' in git.error && git.error.code === 'ENOENT') throw new Error('Git is required to use Relay.');
  if (git.error || git.status !== 0 || !git.stdout.trim()) throw new Error('Choose a Git repository.');
  const selectedRoot = realpathSync(resolve(git.stdout.trim()));
  const common = spawnSync('git', ['-C', selectedRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 128 * 1024
  });
  if (common.error || common.status !== 0 || !common.stdout.trim()) {
    throw new Error('Relay could not resolve the repository main checkout.');
  }
  const commonDirectory = realpathSync(resolve(common.stdout.trim()));
  const projectPath = basename(commonDirectory) === '.git'
    ? realpathSync(dirname(commonDirectory))
    : selectedRoot;
  if (isFilesystemRoot(projectPath)) throw new Error('Choose a project below the filesystem root.');

  const branch = spawnSync('git', ['-C', projectPath, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 128 * 1024
  });
  if (branch.error || branch.status !== 0 || !branch.stdout.trim()) {
    throw new Error('Check out a local branch before opening Relay.');
  }
  if (harnessHome === projectPath || isNestedPath(projectPath, harnessHome) || isNestedPath(harnessHome, projectPath)) {
    throw new Error('Keep Harness Home and the project in separate folders.');
  }

  return {
    onboardingComplete: true,
    harnessHome,
    projectPath,
    orchestratorName: orchestratorName.trim() || DEFAULT_ORCHESTRATOR_NAME,
    orchestratorProvider,
    orchestratorModel: request.orchestratorModel
  };
}

export function isNestedPath(parent: string, candidate: string): boolean {
  const nested = relative(parent, candidate);
  return nested.length > 0 && !nested.startsWith('..') && !isAbsolute(nested);
}

function isFilesystemRoot(path: string): boolean {
  const resolved = resolve(path);
  return parse(resolved).root === resolved;
}
