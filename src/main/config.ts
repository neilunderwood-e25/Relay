import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ORCHESTRATOR_NAME, type WorkspaceConfig } from '../shared/contracts';

const DEFAULT_CONFIG: WorkspaceConfig = {
  onboardingComplete: false,
  harnessHome: null,
  projectPath: null,
  orchestratorName: DEFAULT_ORCHESTRATOR_NAME
};

export class WorkspaceConfigStore {
  constructor(readonly path: string) {}

  read(): WorkspaceConfig {
    if (!existsSync(this.path)) return { ...DEFAULT_CONFIG };
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<WorkspaceConfig>;
      const harnessHome = validPath(parsed.harnessHome) ? parsed.harnessHome : null;
      const projectPath = validPath(parsed.projectPath) ? parsed.projectPath : null;
      const orchestratorName = validName(parsed.orchestratorName)
        ? parsed.orchestratorName.trim()
        : DEFAULT_ORCHESTRATOR_NAME;
      return {
        onboardingComplete: parsed.onboardingComplete === true && !!harnessHome && !!projectPath,
        harnessHome,
        projectPath,
        orchestratorName
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  write(config: WorkspaceConfig): WorkspaceConfig {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(temporary, this.path);
    return config;
  }
}

function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 32;
}
