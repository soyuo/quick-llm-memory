import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { InputError, InternalError } from '../errors/qlm-error.js';

const STATUS_PATH = '/__qlm/manager/status';
const STOP_PATH = '/__qlm/manager/stop';
const ID_HEADER = 'x-qlm-instance-id';
const STARTUP_TIMEOUT_MS = 8_000;
const SHUTDOWN_TIMEOUT_MS = 6_500;
const POLL_INTERVAL_MS = 100;

interface ManagedServerState {
  version: 1;
  pid: number;
  startedAt: string;
  host: string;
  port: number;
  url: string;
  instanceId: string;
  commandIdentity: string;
  logPath: string;
}

interface ProcessManagerDependencies {
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
  entryPoint?: string;
  wait?: (milliseconds: number) => Promise<void>;
}

export type ManagedHttpServerStatus =
  | { state: 'stopped'; message: string }
  | { state: 'stale'; message: string }
  | ({ state: 'running' } & Omit<ManagedServerState, 'version' | 'instanceId' | 'commandIdentity'>);

export interface ManageHttpServerOptions extends ProcessManagerDependencies {
  dataRoot: string;
  host?: string;
  port?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export async function getManagedHttpServerStatus(
  options: ManageHttpServerOptions,
): Promise<ManagedHttpServerStatus> {
  const statePath = getStatePath(options.dataRoot);
  const saved = readState(statePath);
  if (saved === undefined) return { state: 'stopped', message: 'HTTP server is stopped.' };
  if (saved === 'invalid' || !isSafeSavedState(saved)) {
    removeState(statePath);
    return { state: 'stale', message: 'Saved HTTP server state is invalid; no process was contacted.' };
  }

  const live = await queryIdentity(saved, options.fetchImpl ?? fetch);
  if (!sameIdentity(saved, live)) {
    removeState(statePath);
    return { state: 'stale', message: 'Saved HTTP server state is stale; no process was signaled.' };
  }

  return publicStatus(saved);
}

export async function startManagedHttpServer(
  options: ManageHttpServerOptions,
): Promise<ManagedHttpServerStatus> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8765;
  if (!isSafeHostPort(host, port)) throw new InputError('Managed MCP HTTP must use a loopback host and valid port.');
  const existing = await getManagedHttpServerStatus(options);
  if (existing.state === 'running') return existing;

  const instanceId = randomUUID();
  const configuredEntryPoint = options.entryPoint ?? process.argv[1];
  if (configuredEntryPoint === undefined) throw new InternalError('Cannot locate the qlm entry point.');
  const entryPoint = resolve(configuredEntryPoint);

  const args = [entryPoint, 'mcp', 'serve', '--transport', 'http', '--host', host,
    '--port', String(port), '--managed-instance-id', instanceId];
  const commandIdentity = hashCommand(process.execPath, args);
  const logPath = join(options.dataRoot, 'logs', 'mcp-http.log');
  ensureLogFile(logPath);
  const logFd = openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = (options.spawnProcess ?? spawn)(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, QLM_HOME: options.dataRoot },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  await waitForSpawn(child);

  const started = Date.now();
  let identity: ManagedServerState | undefined;
  while (Date.now() - started < (options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS)) {
    const live = await queryIdentity({
      pid: child.pid ?? -1,
      startedAt: '',
      host,
      port,
      url: `http://${formatHost(host)}:${port}/mcp`,
      instanceId,
      commandIdentity,
      logPath,
      version: 1,
    }, options.fetchImpl ?? fetch);
    if (live !== undefined && live.pid === child.pid && live.instanceId === instanceId
      && live.host === host && live.commandIdentity === commandIdentity) {
      identity = { ...live, version: 1, url: `http://${formatHost(host)}:${live.port}/mcp`, logPath };
      break;
    }
    if (child.exitCode !== null || child.signalCode !== null) break;
    await (options.wait ?? delay)(POLL_INTERVAL_MS);
  }

  if (identity === undefined) {
    child.kill();
    throw new InputError('The managed MCP HTTP server did not become ready.', {
      suggestedAction: 'Check the MCP HTTP log and verify that the selected port is available.',
    });
  }

  try {
    writeState(getStatePath(options.dataRoot), identity);
  } catch (error) {
    await (options.fetchImpl ?? fetch)(`${baseUrl(identity)}${STOP_PATH}`, {
      method: 'POST',
      headers: { [ID_HEADER]: identity.instanceId },
      signal: AbortSignal.timeout(1_000),
    }).catch(() => undefined);
    await (options.wait ?? delay)(250);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  }
  return publicStatus(identity);
}

export async function stopManagedHttpServer(
  options: ManageHttpServerOptions,
): Promise<ManagedHttpServerStatus> {
  const statePath = getStatePath(options.dataRoot);
  const saved = readState(statePath);
  if (saved === undefined) return { state: 'stopped', message: 'HTTP server is stopped.' };
  if (saved === 'invalid' || !isSafeSavedState(saved)) {
    removeState(statePath);
    return { state: 'stale', message: 'Saved HTTP server state is invalid; no process was contacted.' };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const current = await queryIdentity(saved, fetchImpl);
  if (!sameIdentity(saved, current)) {
    removeState(statePath);
    return { state: 'stale', message: 'Saved HTTP server state is stale; no process was signaled.' };
  }

  const stopUrl = `${baseUrl(saved)}/${STOP_PATH.slice(1)}`;
  const accepted = await fetchImpl(stopUrl, {
    method: 'POST',
    headers: { [ID_HEADER]: saved.instanceId },
    signal: AbortSignal.timeout(1_000),
  }).catch(() => undefined);
  if (accepted?.status !== 202) {
    return { state: 'stale', message: 'Managed shutdown could not be verified; no process was signaled.' };
  }

  const deadline = Date.now() + (options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const live = await queryIdentity(saved, fetchImpl);
    if (!sameIdentity(saved, live)) {
      removeState(statePath);
      return { state: 'stopped', message: 'HTTP server stopped.' };
    }
    await (options.wait ?? delay)(POLL_INTERVAL_MS);
  }

  const stillSameInstance = await queryIdentity(saved, fetchImpl);
  if (!sameIdentity(saved, stillSameInstance)) {
    removeState(statePath);
    return { state: 'stopped', message: 'HTTP server stopped.' };
  }
  return { state: 'stale', message: 'The managed server did not stop within its drain bound; no PID signal was sent.' };
}

function queryIdentity(
  saved: ManagedServerState,
  fetchImpl: typeof fetch,
): Promise<ManagedServerState | undefined> {
  return fetchImpl(`${baseUrl(saved)}${STATUS_PATH}`, {
    headers: { [ID_HEADER]: saved.instanceId },
    signal: AbortSignal.timeout(750),
  }).then(async (response) => {
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    if (!isLiveIdentity(value)) return undefined;
    return { ...value, version: 1 as const, url: `http://${formatHost(value.host)}:${value.port}/mcp`, logPath: saved.logPath };
  }).catch(() => undefined);
}

function isLiveIdentity(value: unknown): value is Omit<ManagedServerState, 'version' | 'url' | 'logPath'> {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Number.isSafeInteger(candidate.pid) && typeof candidate.startedAt === 'string'
    && typeof candidate.host === 'string' && Number.isSafeInteger(candidate.port)
    && typeof candidate.instanceId === 'string' && typeof candidate.commandIdentity === 'string';
}

function sameIdentity(
  saved: ManagedServerState,
  live: ManagedServerState | undefined,
): boolean {
  return live !== undefined && live.pid === saved.pid && live.startedAt === saved.startedAt
    && live.host === saved.host && live.port === saved.port && live.instanceId === saved.instanceId
    && live.commandIdentity === saved.commandIdentity;
}

function publicStatus(state: ManagedServerState): ManagedHttpServerStatus {
  return {
    state: 'running',
    pid: state.pid,
    startedAt: state.startedAt,
    host: state.host,
    port: state.port,
    url: state.url,
    logPath: state.logPath,
  };
}

function readState(path: string): ManagedServerState | 'invalid' | undefined {
  let fileIsRegular: boolean;
  try {
    fileIsRegular = lstatSync(path).isFile();
  } catch {
    return undefined;
  }
  if (!fileIsRegular) return 'invalid';
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof value !== 'object' || value === null) return 'invalid';
    const state = value as Record<string, unknown>;
    if (state.version !== 1 || !Number.isSafeInteger(state.pid) || typeof state.startedAt !== 'string'
      || typeof state.host !== 'string' || !Number.isSafeInteger(state.port) || typeof state.url !== 'string'
      || typeof state.instanceId !== 'string' || typeof state.commandIdentity !== 'string'
      || typeof state.logPath !== 'string') return 'invalid';
    return state as unknown as ManagedServerState;
  } catch {
    return 'invalid';
  }
}

function isSafeSavedState(state: ManagedServerState): boolean {
  return isSafeHostPort(state.host, state.port)
    && state.url === `${baseUrl(state)}/mcp`;
}

function isSafeHostPort(host: string, port: number): boolean {
  const family = isIP(host);
  const loopback = host.toLowerCase() === 'localhost'
    || (family === 4 && host.split('.')[0] === '127')
    || (family === 6 && host === '::1');
  return loopback && Number.isSafeInteger(port) && port >= 1 && port <= 65_535;
}

function writeState(path: string, state: ManagedServerState): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new InputError('MCP manager state path is not a regular file.');
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function removeState(path: string): void {
  try {
    if (lstatSync(path).isFile()) unlinkSync(path);
  } catch {
    // A missing or non-regular state file is not a process identity.
  }
}

function ensureLogFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (!lstatSync(path).isFile()) throw new InputError('MCP HTTP log path is not a regular file.');
    return;
  }
  const fd = openSync(path, 'wx', 0o600);
  closeSync(fd);
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function hashCommand(executable: string, args: string[]): string {
  return createHash('sha256').update(JSON.stringify([executable, ...args])).digest('hex');
}

function baseUrl(state: Pick<ManagedServerState, 'host' | 'port'>): string {
  return `http://${formatHost(state.host)}:${state.port}`;
}

function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

function getStatePath(dataRoot: string): string {
  return join(dataRoot, 'mcp', 'http-server.json');
}

export function getExpectedManagedCommandIdentity(entryPoint: string, args: string[]): string {
  return hashCommand(process.execPath, [entryPoint, ...args]);
}

