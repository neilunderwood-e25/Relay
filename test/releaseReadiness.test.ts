import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TerminalBuffer } from '../src/main/terminalBuffer';

describe('release readiness contract', () => {
  it('defines a reproducible unsigned macOS package', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
      build: { asar: boolean; artifactName: string; mac: Record<string, unknown> };
    };
    expect(manifest.scripts['dist:mac:unsigned']).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false');
    expect(manifest.scripts['dist:mac']).toBe('npm run dist:mac:unsigned');
    expect(manifest.scripts['test:e2e']).toContain('npm run test:cli');
    expect(manifest.build).toMatchObject({ asar: true, artifactName: 'Relay-${version}-${arch}.${ext}' });
    expect(manifest.build.mac).toMatchObject({ identity: null, forceCodeSigning: false, hardenedRuntime: false });
  });

  it('denies renderer permissions and top-level navigation', () => {
    const main = readFileSync('src/main/index.ts', 'utf8');
    const html = readFileSync('src/renderer/index.html', 'utf8');
    expect(main).toContain('setPermissionCheckHandler(() => false)');
    expect(main).toContain('setPermissionRequestHandler');
    expect(main).toContain("on('will-navigate', (event) => event.preventDefault())");
    expect(html).toContain('Content-Security-Policy');
  });

  it('bounds retained terminal output to one MiB by default', () => {
    const buffer = new TerminalBuffer();
    buffer.append('x'.repeat(1024 * 1024 + 10));
    expect(buffer.length).toBe(1024 * 1024);
  });

  it('keeps startup verification mandatory on every launch', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8');
    expect(app).toContain('const [startupVerified, setStartupVerified] = useState(false)');
    expect(app).toContain('if (!startupVerified)');
  });

  it('starts one shared Michael terminal after startup verification', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8');
    const workspace = readFileSync('src/renderer/src/components/OrchestratorWorkspace.tsx', 'utf8');
    const terminal = readFileSync('src/renderer/src/components/OrchestratorTerminal.tsx', 'utf8');

    expect(app).toContain('window.relay.ensureOrchestratorSession()');
    expect(app).toContain('orchestratorTerminal={orchestratorTerminal}');
    expect(workspace).toContain('terminal={orchestratorTerminal}');
    expect(terminal).toContain('<TerminalView key={terminal.id} terminal={terminal} />');
  });

  it('routes unified human input and Michael actions through the trusted main process', () => {
    const preload = readFileSync('src/preload/index.ts', 'utf8');
    const main = readFileSync('src/main/index.ts', 'utf8');
    const protocol = readFileSync('src/main/orchestratorActions.ts', 'utf8');
    expect(preload).toContain('orchestratorInputSubmit');
    expect(main).toContain('validateOrchestratorInput');
    expect(main).toContain('executeOrchestratorAction');
    expect(protocol).toContain('ACTION_KINDS');
    expect(protocol).toContain('validateOrchestratorAction');
  });

  it('bounds and sanitizes the live Monitor projection in the main process', () => {
    const projection = readFileSync('src/main/liveProjection.ts', 'utf8');
    expect(projection).toContain('MAX_RAW_CHARACTERS = 64 * 1024');
    expect(projection).toContain('MAX_LINES = 8');
    expect(projection).toContain('ANSI_PATTERN');
    expect(projection).toContain('event.id !== this.state.terminalId');
  });

  it('enforces selected-project and terminal safety in the main process', () => {
    const main = readFileSync('src/main/index.ts', 'utf8');
    const safety = readFileSync('src/main/safety.ts', 'utf8');
    const adapters = readFileSync('src/main/providerAdapters.ts', 'utf8');
    expect(main).toContain('safetyBoundary.assertProjectPath');
    expect(main).toContain('safetyBoundary.assertRendererTerminal');
    expect(main).toContain('cwd: activeHive.agentRoot');
    expect(safety).toContain('app.safety.denied');
    expect(safety).toContain('cannot supply CLI arguments');
    expect(adapters).toContain("'--restricted'");
  });

  it('gates Claude workspace trust to the Relay Hive before control delivery', () => {
    const bootstrap = readFileSync('src/main/orchestratorBootstrap.ts', 'utf8');
    const main = readFileSync('src/main/index.ts', 'utf8');
    expect(bootstrap).toContain('resolve(initial.cwd) !== resolve(hiveAgentRoot)');
    expect(bootstrap).toContain("output.includes('Quick safety check:')");
    expect(bootstrap).toContain("output.includes('Yes, I trust this folder')");
    expect(main).toContain('await prepareOrchestratorTerminal');
  });
});
