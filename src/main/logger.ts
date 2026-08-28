import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export interface AppLogger {
  logger: Logger;
  logPath: string;
}

export function createAppLogger(logDirectory: string): AppLogger {
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, 'foundry.log');
  const file = pino.destination({ dest: logPath, sync: false });
  const streams: pino.StreamEntry[] = [{ stream: file }];

  if (!process.env.CI) {
    streams.push({ stream: process.stdout });
  }

  return {
    logPath,
    logger: pino(
      {
        level: process.env.FOUNDRY_LOG_LEVEL ?? 'info',
        base: {
          service: 'foundry-harness',
          pid: process.pid
        },
        timestamp: pino.stdTimeFunctions.isoTime
      },
      pino.multistream(streams)
    )
  };
}
