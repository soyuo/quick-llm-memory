import { spawn, type ChildProcess } from 'node:child_process';
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

// Only fixed flags, model names, and relative file names reach argv; prompts use stdin.
const SAFE_WINDOWS_ARG = /^[A-Za-z0-9_.:/@=+,-]*$/;
const MAX_OUTPUT_CHARS = 8 * 1024 * 1024;

/**
 * Runs a vendor CLI without a shell. On Windows npm installs `.cmd` shims, which
 * Node cannot spawn directly, so arguments are restricted to a safe alphabet and
 * routed through cmd.exe. Prompts are always sent on stdin, never in argv.
 */
export const runCli: CliRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    let file = command;
    let fileArgs = [...args];
    if (windows) {
      if (!SAFE_WINDOWS_ARG.test(command) || args.some((arg) => !SAFE_WINDOWS_ARG.test(arg))) {
        reject(new ProviderError('A CLI argument contains characters that are not allowed.'));
        return;
      }
      file = process.env.ComSpec ?? 'cmd.exe';
      fileArgs = ['/d', '/s', '/c', `"${[command, ...args].map((arg) => `"${arg}"`).join(' ')}"`];
    }

    const child = spawn(file, fileArgs, {
      shell: false,
      windowsVerbatimArguments: windows,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: options.inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const collect = (current: string, chunk: string): string =>
      current.length >= MAX_OUTPUT_CHARS ? current : current + chunk;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout = collect(stdout, chunk); });
    child.stderr?.on('data', (chunk: string) => { stderr = collect(stderr, chunk); });

    const timer = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { timedOut = true; killTree(child); }, options.timeoutMs);
    const onAbort = (): void => { aborted = true; killTree(child); };
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(new ProviderError(
        error.code === 'ENOENT'
          ? `The ${command} command was not found. Install it and make sure it is on PATH.`
          : `The ${command} command could not be started.`,
        { cause: error },
      ));
    });
    child.once('close', (exitCode) => {
      cleanup();
      if (aborted) {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      } else if (timedOut) {
        reject(new ProviderError(`The ${command} command timed out after ${options.timeoutMs} ms.`));
      } else {
        resolve({ stdout, stderr, exitCode });
      }
    });
    if (!options.inherit) {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.input ?? '');
    }
  });

/** On Windows, cmd.exe wraps the real CLI, so the whole tree must be stopped. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false })
      .once('error', () => child.kill());
    return;
  }
  child.kill();
}
