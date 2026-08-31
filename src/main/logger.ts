import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export interface AppLogger {
  logger: Logger;
  logPath: string;
}

export function createAppLogger(logDirectory: string): AppLogger {
  mkdirSync(logDirectory, { recursive: true });
  const logPath = join(logDirectory, 'relay.log');
  const file = pino.destination({ dest: logPath, sync: false });
  // Electron can outlive the terminal that launched it. Writing through
  // standard output after that PTY disappears raises EIO and can terminate the
  // main process, so the application logger must remain file-backed only.
  file.on('error', () => undefined);

  return {
    logPath,
    logger: pino(
      {
        level: process.env.RELAY_LOG_LEVEL ?? 'info',
        base: {
          service: 'relay-harness',
          pid: process.pid
        },
        timestamp: pino.stdTimeFunctions.isoTime
      },
      file
    )
  };
}
