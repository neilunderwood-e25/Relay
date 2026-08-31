import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The preview server intentionally remains plain, directly executable JavaScript.
// @ts-expect-error TypeScript declarations are unnecessary for this local script.
import { startSiteServer } from '../scripts/serve-site.mjs';

let fixtureRoot: string;
let site: Awaited<ReturnType<typeof startSiteServer>>;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'relay-site-test-'));
  await mkdir(join(fixtureRoot, 'nested'));
  await Promise.all([
    writeFile(join(fixtureRoot, 'index.html'), '<!doctype html><h1>Relay</h1>'),
    writeFile(join(fixtureRoot, 'nested', 'index.html'), '<!doctype html><h1>Nested</h1>'),
    writeFile(join(fixtureRoot, 'styles.css'), 'body { color: navy; }'),
    writeFile(join(fixtureRoot, 'feed.xml'), '<?xml version="1.0"?><rss version="2.0"></rss>'),
    writeFile(join(fixtureRoot, 'feed.atom'), '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>'),
    writeFile(join(fixtureRoot, 'robots.txt'), 'User-agent: *\nDisallow:\n'),
    writeFile(join(fixtureRoot, 'asset.bin'), new Uint8Array([0, 1, 2, 255]))
  ]);
  site = await startSiteServer({ root: fixtureRoot, port: 0 });
});

afterAll(async () => {
  await site?.close();
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

describe('static site preview server', () => {
  it('serves root and nested directory indexes as HTML', async () => {
    const rootResponse = await fetch(`${site.url}/`);
    expect(rootResponse.status).toBe(200);
    expect(rootResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    await expect(rootResponse.text()).resolves.toContain('Relay');

    const nestedResponse = await fetch(`${site.url}/nested/`);
    expect(nestedResponse.status).toBe(200);
    expect(nestedResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
    await expect(nestedResponse.text()).resolves.toContain('Nested');
  });

  it('serves known and fallback content types', async () => {
    const cssResponse = await fetch(`${site.url}/styles.css`);
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8');

    const assetResponse = await fetch(`${site.url}/asset.bin`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe('application/octet-stream');
    expect([...new Uint8Array(await assetResponse.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });

  it('serves feed and plain-text content types', async () => {
    const xmlResponse = await fetch(`${site.url}/feed.xml`);
    expect(xmlResponse.status).toBe(200);
    expect(xmlResponse.headers.get('content-type')).toBe('application/xml; charset=utf-8');

    const atomResponse = await fetch(`${site.url}/feed.atom`);
    expect(atomResponse.status).toBe(200);
    expect(atomResponse.headers.get('content-type')).toBe('application/atom+xml; charset=utf-8');

    const textResponse = await fetch(`${site.url}/robots.txt`);
    expect(textResponse.status).toBe(200);
    expect(textResponse.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('supports HEAD without returning a body', async () => {
    const response = await fetch(`${site.url}/styles.css`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
    await expect(response.text()).resolves.toBe('');
  });

  it('returns concise errors for missing files and unsupported methods', async () => {
    const missingResponse = await fetch(`${site.url}/missing.html`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.text()).toContain('404 Not Found');

    const methodResponse = await fetch(`${site.url}/`, { method: 'POST' });
    expect(methodResponse.status).toBe(405);
    expect(methodResponse.headers.get('allow')).toBe('GET, HEAD');
  });

  it('rejects encoded path traversal', async () => {
    const response = await fetch(`${site.url}/%2e%2e%2foutside.txt`);
    expect(response.status).toBe(403);
  });
});
