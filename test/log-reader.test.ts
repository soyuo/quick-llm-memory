import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatSanitizedLogExport, readApplicationLogs, filterApplicationLogs } from '../src/logging/log-reader.js';
import { resolveLogFilePath } from '../src/logging/logger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('application log reader', () => {
  it('reads a bounded tail in stable newest-first order and exposes safe summaries only', () => {
    const root = createRoot();
    const logPath = resolveLogFilePath(root);
    mkdirSync(dirname(logPath), { recursive: true });
    const lines = Array.from({ length: 205 }, (_, index) => JSON.stringify({
      time: 1_700_000_000_000 + index,
      level: index === 204 ? 50 : 30,
      event: index === 204 ? 'application.error' : 'project.created',
      msg: index === 204 ? 'private message' : 'Project created',
      prompt: 'private prompt',
      authorization: 'Bearer private-token',
      password: 'private-password',
      errorCode: index === 204 ? 'QLM_INPUT_ERROR' : undefined,
    }));
    writeFileSync(logPath, lines.join('\n'));

    const snapshot = readApplicationLogs(root);
    const exported = formatSanitizedLogExport(snapshot.entries);

    expect(snapshot.status).toBe('ready');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.entries).toHaveLength(200);
    expect(snapshot.entries[0]?.summary).toBe('Application error: QLM_INPUT_ERROR');
    expect(snapshot.entries[1]?.summary).toBe('Project created');
    expect(filterApplicationLogs(snapshot.entries, 'errors')).toHaveLength(1);
    expect(filterApplicationLogs(snapshot.entries, 'operations')).toHaveLength(199);
    expect(filterApplicationLogs(snapshot.entries, 'mcp')).toHaveLength(0);
    expect(exported).not.toContain('private');
    expect(exported).not.toContain('Bearer');
  });

  it('distinguishes a missing log from a non-regular log path', () => {
    const root = createRoot();
    expect(readApplicationLogs(root).status).toBe('missing');
    const logPath = resolveLogFilePath(root);
    mkdirSync(logPath, { recursive: true });
    expect(readApplicationLogs(root).status).toBe('unavailable');
  });

  it('keeps malformed timestamp values from interrupting log inspection', () => {
    const root = createRoot();
    const logPath = resolveLogFilePath(root);
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${JSON.stringify({ time: 1e100, level: 30, event: 'application.started' })}\n`);

    const snapshot = readApplicationLogs(root);

    expect(snapshot.status).toBe('ready');
    expect(snapshot.entries[0]?.timestamp).toBe('Unknown time');
  });
});

function createRoot(): string {
  const root = mkdtempSync(`${tmpdir()}\\qlm-logs-`);
  roots.push(root);
  return root;
}
