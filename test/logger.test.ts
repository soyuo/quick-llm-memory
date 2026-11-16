import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  resolveLogFilePath,
} from '../src/logging/logger.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('application logger', () => {
  it('writes structured events at the configured level and redacts sensitive fields', () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-logger-'));
    temporaryDirectories.push(dataRoot);
    const output: string[] = [];
    const destination: pino.DestinationStream = {
      write: (message) => output.push(message),
    };

    const logger = createApplicationLogger({
      dataRoot,
      level: 'info',
      destination,
    });
    logger.debug({ event: 'debug.filtered' }, 'Filtered debug event');
    logger.info(
      {
        event: 'safe.metadata',
        prompt: 'private prompt text',
        apiKey: 'private key',
        nested: { content: 'private content' },
      },
      'Safe metadata event',
    );
    logProjectCreated(logger, 'project-123');
    logApplicationError(logger, new InputError('private error details'));

    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records.map((record) => record.event)).toEqual([
      'application.started',
      'safe.metadata',
      'project.created',
      'application.error',
    ]);
    expect(records[1]).toMatchObject({
      prompt: '[Redacted]',
      apiKey: '[Redacted]',
      nested: { content: '[Redacted]' },
    });
    expect(records[2].projectId).toBe('project-123');
    expect(records[3]).toMatchObject({
      errorCode: 'QLM_INPUT_ERROR',
      errorName: 'InputError',
    });
    expect(output.join('')).not.toContain('private prompt text');
    expect(output.join('')).not.toContain('private key');
    expect(output.join('')).not.toContain('private content');
    expect(output.join('')).not.toContain('private error details');
    expect(existsSync(join(dataRoot, 'logs'))).toBe(true);
  });

  it('resolves the log file under the configured data root', () => {
    expect(resolveLogFilePath('workspace-data')).toBe(
      join('workspace-data', 'logs', 'application.log'),
    );
  });
});
