import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { QLMError } from '../errors/qlm-error.js';
import type { Settings } from '../config/schema.js';

const REDACTED_FIELDS = [
  'prompt',
  'messages',
  'content',
  'apiKey',
  'api_key',
  'authorization',
  'secret',
  'token',
  '*.prompt',
  '*.messages',
  '*.content',
  '*.apiKey',
  '*.api_key',
  '*.authorization',
  '*.secret',
  '*.token',
];

export interface CreateApplicationLoggerOptions {
  dataRoot: string;
  level: Settings['logging']['level'];
  destination?: pino.DestinationStream;
}

export function resolveLogFilePath(dataRoot: string): string {
  return join(dataRoot, 'logs', 'application.log');
}

export function createApplicationLogger(
  options: CreateApplicationLoggerOptions,
): pino.Logger {
  const logFilePath = resolveLogFilePath(options.dataRoot);
  mkdirSync(dirname(logFilePath), { recursive: true });

  const destination =
    options.destination ??
    pino.destination({ dest: logFilePath, sync: true });
  const logger = pino(
    {
      name: 'quick-llm-memory',
      level: options.level,
      redact: REDACTED_FIELDS,
    },
    destination,
  );

  logApplicationStarted(logger);
  return logger;
}

export function logApplicationStarted(logger: pino.Logger): void {
  logger.info({ event: 'application.started' }, 'Application started');
}

export function logProjectCreated(
  logger: pino.Logger,
  projectId: string,
): void {
  logger.info({ event: 'project.created', projectId }, 'Project created');
}

export function logApplicationError(
  logger: pino.Logger,
  error: unknown,
): void {
  const errorMetadata =
    error instanceof QLMError
      ? { errorCode: error.code, errorName: error.name }
      : {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        };

  logger.error(
    { event: 'application.error', ...errorMetadata },
    'Application error',
  );
}
