import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppLogger } from '../src/main/logger';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createAppLogger', () => {
  it('uses a durable file destination without depending on process stdout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-logger-test-'));
    temporaryDirectories.push(directory);
    const { logger, logPath } = createAppLogger(directory);

    logger.info({ check: true }, 'Logger ready');
    await new Promise<void>((resolve) => logger.flush(() => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('Logger ready');
    expect(readFileSync('src/main/logger.ts', 'utf8')).not.toContain('process.stdout');
    expect(readFileSync('src/main/logger.ts', 'utf8')).not.toContain('pino.multistream');
  });
});
