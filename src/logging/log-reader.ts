import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { resolveLogFilePath } from './logger.js';

const MAX_LOG_BYTES = 256 * 1024;
const MAX_LOG_ENTRIES = 200;
const LEVELS = new Map<number, string>([
  [10, 'trace'], [20, 'debug'], [30, 'info'], [40, 'warn'], [50, 'error'], [60, 'fatal'],
]);

export type ApplicationLogView = 'all' | 'operations' | 'errors' | 'mcp';
export type ApplicationLogKind = 'operation' | 'error' | 'mcp' | 'other';

export interface ApplicationLogEntry {
  index: number;
  timestamp: string;
  level: string;
  kind: ApplicationLogKind;
  summary: string;
}

export interface ApplicationLogSnapshot {
  status: 'ready' | 'missing' | 'unavailable';
  entries: ApplicationLogEntry[];
  truncated: boolean;
}

export function readApplicationLogs(dataRoot: string): ApplicationLogSnapshot {
  const filePath = resolveLogFilePath(dataRoot);
  let descriptor: number | undefined;
  try {
    const before = lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile()) {
      return unavailable();
    }
    descriptor = openSync(filePath, 'r');
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      return unavailable();
    }

    const byteCount = Math.min(opened.size, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(byteCount);
    readSync(descriptor, buffer, 0, byteCount, opened.size - byteCount);
    let text = buffer.toString('utf8');
    if (opened.size > byteCount) {
      const firstLine = text.indexOf('\n');
      text = firstLine < 0 ? '' : text.slice(firstLine + 1);
    }

    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    const truncated = lines.length > MAX_LOG_ENTRIES || opened.size > byteCount;
    const entries = lines.slice(-MAX_LOG_ENTRIES).flatMap((line, index) => {
      try {
        const value: unknown = JSON.parse(line);
        return isRecord(value) ? [toSafeEntry(value, index)] : [];
      } catch {
        return [];
      }
    }).reverse();
    return { status: 'ready', entries, truncated };
  } catch (error) {
    if (isMissingFile(error)) {
      return { status: 'missing', entries: [], truncated: false };
    }
    return unavailable();
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function filterApplicationLogs(
  entries: readonly ApplicationLogEntry[],
  view: ApplicationLogView,
): ApplicationLogEntry[] {
  if (view === 'all') return [...entries];
  if (view === 'operations') return entries.filter(({ kind }) => kind === 'operation');
  if (view === 'errors') return entries.filter(({ kind }) => kind === 'error');
  return entries.filter(({ kind }) => kind === 'mcp');
}

export function formatSanitizedLogExport(entries: readonly ApplicationLogEntry[]): string {
  return entries.slice(0, 50).map(({ timestamp, level, kind, summary }) =>
    JSON.stringify({ timestamp, level, kind, summary }),
  ).join('\n');
}

function toSafeEntry(value: Record<string, unknown>, index: number): ApplicationLogEntry {
  const event = typeof value.event === 'string' ? value.event : '';
  const numericLevel = typeof value.level === 'number' ? value.level : 0;
  const kind: ApplicationLogKind = event === 'application.error' || numericLevel >= 50
    ? 'error'
    : event.includes('.mcp.') || event.startsWith('mcp.')
      ? 'mcp'
      : event === 'application.started' || event === 'project.created' || event === 'project.reindexed'
        ? 'operation'
        : 'other';
  const date = typeof value.time === 'number' ? new Date(value.time) : undefined;
  const timestamp = date !== undefined && Number.isFinite(date.valueOf())
    ? date.toISOString()
    : 'Unknown time';
  const level = LEVELS.get(numericLevel) ?? 'unknown';
  let summary: string;
  if (event === 'application.started') {
    summary = 'Application started';
  } else if (event === 'project.created') {
    summary = 'Project created';
  } else if (event === 'project.reindexed') {
    const count = Number.isSafeInteger(value.documentCount) && Number(value.documentCount) >= 0
      ? ` (${String(value.documentCount)} documents)`
      : '';
    summary = `Project reindexed${count}`;
  } else if (kind === 'error') {
    const code = typeof value.errorCode === 'string' && /^QLM_[A-Z0-9_]{1,60}$/u.test(value.errorCode)
      ? value.errorCode
      : 'Unexpected error';
    summary = `Application error: ${code}`;
  } else if (kind === 'mcp') {
    summary = 'MCP activity';
  } else {
    summary = 'Application event';
  }
  return { index, timestamp, level, kind, summary };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function unavailable(): ApplicationLogSnapshot {
  return { status: 'unavailable', entries: [], truncated: false };
}
