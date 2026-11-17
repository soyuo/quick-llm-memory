import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { QLMError } from '../errors/qlm-error.js';
import type { Settings } from '../config/schema.js';

const SAFE_MESSAGES = new Set([
  'Application started',
  'Project created',
  'Application error',
  'Project reindexed',
]);

const SENSITIVE_FIELDS = new Set([
  'query',
  'question',
  'text',
  'password',
  'cookie',
  'credential',
  'privatekey',
]);

export interface CreateApplicationLoggerOptions {
  dataRoot: string;
  level: Settings['logging']['level'];
  destination?: pino.DestinationStream;
}

export type ApplicationLogger = pino.Logger & {
  close(): Promise<void>;
};

export function resolveLogFilePath(dataRoot: string): string {
  return join(dataRoot, 'logs', 'application.log');
}

export function createApplicationLogger(
  options: CreateApplicationLoggerOptions,
): ApplicationLogger {
  const logFilePath = resolveLogFilePath(options.dataRoot);
  mkdirSync(dirname(logFilePath), { recursive: true });

  const fileDestination =
    options.destination === undefined
      ? pino.destination({ dest: logFilePath, sync: true })
      : undefined;
  const destination = options.destination ?? fileDestination;
  const logger = pino(
    {
      name: 'quick-llm-memory',
      level: options.level,
      hooks: {
        streamWrite: (line) =>
          `${JSON.stringify(sanitizeLogValue(JSON.parse(line)))}\n`,
      },
    },
    destination,
  );

  logApplicationStarted(logger);
  return Object.assign(logger, {
    close: () => {
      if (fileDestination === undefined) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve, reject) => {
        fileDestination.once('close', resolve);
        fileDestination.once('error', reject);
        fileDestination.end();
      });
    },
  });
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

export function logProjectReindexed(
  logger: pino.Logger,
  projectId: string,
  result: { categories: number; documents: number; relations: number },
): void {
  logger.info(
    {
      event: 'project.reindexed',
      projectId,
      categoryCount: result.categories,
      documentCount: result.documents,
      relationCount: result.relations,
    },
    'Project reindexed',
  );
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

function sanitizeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeLogValue);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, fieldValue]) => {
      if (key === 'msg' && typeof fieldValue === 'string') {
        return [key, SAFE_MESSAGES.has(fieldValue) ? fieldValue : '[Redacted]'];
      }

      const normalizedKey = key.replaceAll(/[-_]/g, '').toLowerCase();
      if (
        normalizedKey.includes('prompt') ||
        normalizedKey.includes('message') ||
        normalizedKey.includes('content') ||
        normalizedKey.includes('input') ||
        normalizedKey.includes('output') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('authorization') ||
        normalizedKey.includes('apikey') ||
        normalizedKey.includes('token') ||
        SENSITIVE_FIELDS.has(normalizedKey)
      ) {
        return [key, '[Redacted]'];
      }

      return [key, sanitizeLogValue(fieldValue)];
    }),
  );
}
