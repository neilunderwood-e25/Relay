import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceConfigStore } from '../src/main/config';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { root: string; store: WorkspaceConfigStore } {
  const root = mkdtempSync(join(tmpdir(), 'relay-config-test-'));
  temporaryDirectories.push(root);
  return { root, store: new WorkspaceConfigStore(join(root, 'app', 'config.json')) };
}

describe('WorkspaceConfigStore', () => {
  it('starts without an implicit project', () => {
    const { store } = fixture();
    expect(store.read()).toEqual({
      onboardingComplete: false,
      harnessHome: null,
      projectPath: null,
      orchestratorName: 'Michael'
    });
    expect(existsSync(store.path)).toBe(false);
  });

  it('persists the selected Harness Home and project', () => {
    const { store } = fixture();
    const config = {
      onboardingComplete: true,
      harnessHome: '/tmp/relay-home',
      projectPath: '/tmp/coding-project',
      orchestratorName: 'Michael'
    };
    expect(store.write(config)).toEqual(config);
    expect(store.read()).toEqual(config);
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual(config);
  });

  it('returns onboarding for incomplete or malformed configuration', () => {
    const { store } = fixture();
    store.write({ onboardingComplete: true, harnessHome: '/tmp/home', projectPath: '/tmp/project', orchestratorName: 'Michael' });
    writeFileSync(store.path, '{broken', 'utf8');
    expect(store.read().onboardingComplete).toBe(false);

    writeFileSync(store.path, JSON.stringify({ onboardingComplete: true, harnessHome: '/tmp/home' }), 'utf8');
    expect(store.read()).toEqual({
      onboardingComplete: false,
      harnessHome: '/tmp/home',
      projectPath: null,
      orchestratorName: 'Michael'
    });
  });
});
