import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayDatabase } from '../src/main/database';
import { ExtensionRegistry } from '../src/main/extensions';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): { database: RelayDatabase; extensions: ExtensionRegistry } {
  const directory = mkdtempSync(join(tmpdir(), 'relay-extensions-test-'));
  temporaryDirectories.push(directory);
  const database = new RelayDatabase(join(directory, 'relay.db'));
  database.open();
  return { database, extensions: new ExtensionRegistry(database) };
}

describe('ExtensionRegistry', () => {
  it('creates and updates safe CLI-backed agent profiles', () => {
    const { database, extensions } = fixture();
    const created = extensions.saveProfile({
      name: ' Avery ',
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      instructions: 'Own renderer work.'
    });
    const updated = extensions.saveProfile({ ...created, name: 'Avery Chen', enabled: false });

    expect(updated).toMatchObject({
      id: created.id,
      name: 'Avery Chen',
      provider: 'claude',
      enabled: false
    });
    expect(extensions.listProfiles()).toEqual([updated]);
    expect(database.listEvents().events.map(({ type }) => type)).toEqual([
      'extension.profile.updated',
      'extension.profile.created'
    ]);
    database.close();
  });

  it('saves teams and unlinks a deleted profile from every template', () => {
    const { database, extensions } = fixture();
    const profile = extensions.saveProfile({ name: 'Morgan', provider: 'codex' });
    const template = extensions.saveTemplate({
      name: 'Release audit',
      objective: 'Audit the release candidate.',
      strategy: 'audit',
      profileIds: [profile.id],
      concurrency: 9
    });

    expect(template).toMatchObject({ profileIds: [profile.id], concurrency: 4 });
    expect(extensions.deleteProfile(profile.id)).toEqual({ ok: true });
    expect(extensions.listTemplates()[0].profileIds).toEqual([]);
    database.close();
  });

  it('rejects command-shaped model identifiers and invalid profile names', () => {
    const { database, extensions } = fixture();
    expect(() => extensions.saveProfile({ name: 'Agent', provider: 'codex', model: 'gpt-5; rm -rf' }))
      .toThrow('valid model identifier');
    expect(() => extensions.saveProfile({ name: '<script>', provider: 'claude' }))
      .toThrow('profile name');
    database.close();
  });
});
