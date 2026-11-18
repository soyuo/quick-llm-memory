import { spawn } from 'node:child_process';
import { ProviderError } from './provider-error.js';

export interface CliRunOptions {
  input?: string;
  signal?: AbortSignal;
  cwd?: string;
  timeoutMs?: number;
  /** Inherit the terminal so interactive/browser login flows can run. */
  inherit?: boolean;
}

export interface CliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type CliRunner = (
  command: string,
  args: readonly string[],
  options?: CliRunOptions,
) => Promise<CliRunResult>;

const SAFE_WINDOWS_ARG = /^[A-Za-z0-9_.:\\/@=+, -]*$/;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * Runs a vendor CLI without a shell. On Windows npm installs `.cmd` shims, which
 * Node cannot spawn directly, so arguments are restricted to a safe alphabet and
 * routed through cmd.exe. Prompts are always sent on stdin, never in argv.
 */
export const runCli: CliRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    let file = command;
    let fileArgs = [...args];
    if (process.platform === 'win32') {
      if (!SAFE_WINDOWS_ARG.test(command) || args.some((arg) => !SAFE_WINDOWS_ARG.test(arg))) {
        reject(new ProviderError('A CLI argument contains characters that are not allowed.'));
        return;
      }
      file = process.env.ComSpec ?? 'cmd.exe';
      fileArgs = ['/d', '/s', '/c', `"${[command, ...args].map((arg) => `"${arg}"`).join(' ')}"`];
    }

    const child = spawn(file, fileArgs, {
      shell: false,
      windowsVerbatimArguments: process.platform === 'win32',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });

    let stdout = '';
    let stderr = '';
    const collect = (current: string, chunk: Buffer): string =>
      current.length > MAX_OUTPUT_BYTES ? current : current + chunk.toString('utf8');
    child.stdout?.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk); });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError') {
        reject(error);
        return;
      }
      reject(new ProviderError(
        error.code === 'ENOENT'
          ? `The ${command} command was not found. Install it and make sure it is on PATH.`
          : `The ${command} command could not be started.`,
        { cause: error },
      ));
    });
    child.once('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
    if (!options.inherit) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    }
  });
