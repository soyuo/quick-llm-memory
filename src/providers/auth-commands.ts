import type { Command } from 'commander';
import { InputError } from '../errors/qlm-error.js';
import { runCli, type CliRunner } from './cli-runner.js';

export interface AuthCommandOptions {
  authRunner?: CliRunner;
  writeOut?: (text: string) => void;
}

type AuthTarget = 'codex' | 'claude';

const TARGETS: Record<AuthTarget, {
  label: string;
  command: string;
  login: string[];
  deviceLogin?: string[];
  status: string[];
  logout: string[];
}> = {
  codex: {
    label: 'OpenAI Codex (ChatGPT subscription)',
    command: 'codex',
    login: ['login'],
    deviceLogin: ['login', '--device-auth'],
    status: ['login', 'status'],
    logout: ['logout'],
  },
  claude: {
    label: 'Claude Code (Anthropic account)',
    command: 'claude',
    login: ['auth', 'login'],
    status: ['auth', 'status'],
    logout: ['auth', 'logout'],
  },
};

/**
 * Delegates sign-in to the vendor CLIs. They run the browser redirect flow and
 * keep the tokens themselves; qlm never reads or stores subscription credentials.
 */
export function registerAuthCommands(cli: Command, options: AuthCommandOptions = {}): void {
  const run = options.authRunner ?? runCli;
  const writeOut = options.writeOut ?? ((text: string) => process.stdout.write(text));
  const auth = cli.command('auth').description('Sign in to subscription-based AI providers');

  auth
    .command('login <provider>')
    .description('Sign in with a browser redirect (provider: codex or claude)')
    .option('--device', 'Use device-code login when no browser is available (codex only)')
    .action(async (provider: string, { device }: { device?: boolean }) => {
      const target = parseTarget(provider);
      const definition = TARGETS[target];
      if (device && definition.deviceLogin === undefined) {
        throw new InputError('--device is only supported for codex.');
      }
      writeOut(`Signing in to ${definition.label}; follow the browser prompt.\n`);
      const result = await run(definition.command, device ? definition.deviceLogin! : definition.login, { inherit: true });
      if (result.exitCode !== 0) {
        throw new InputError(`${definition.command} login did not complete.`, {
          suggestedAction: `Run qlm auth login ${target} again.`,
        });
      }
      writeOut(`Signed in. Set ai.provider to ${target === 'codex' ? 'codex-cli' : 'claude-code'} in config.yaml or TUI Settings.\n`);
    });

  auth
    .command('status [provider]')
    .description('Show subscription login status (default: all)')
    .action(async (provider: string | undefined) => {
      const targets = provider === undefined ? (Object.keys(TARGETS) as AuthTarget[]) : [parseTarget(provider)];
      for (const target of targets) {
        const definition = TARGETS[target];
        try {
          const result = await run(definition.command, definition.status);
          writeOut(`${target}: ${formatStatus(result.stdout, result.stderr, result.exitCode)}\n`);
        } catch (error) {
          writeOut(`${target}: ${error instanceof Error ? error.message : `${definition.command} CLI unavailable`}\n`);
        }
      }
    });

  auth
    .command('logout <provider>')
    .description('Sign out of a subscription provider')
    .action(async (provider: string) => {
      const target = parseTarget(provider);
      const definition = TARGETS[target];
      const result = await run(definition.command, definition.logout, { inherit: true });
      if (result.exitCode !== 0) {
        throw new InputError(`${definition.command} logout did not complete.`);
      }
      writeOut(`Signed out of ${definition.label}.\n`);
    });
}

function parseTarget(value: string): AuthTarget {
  if (value === 'codex' || value === 'claude') {
    return value;
  }
  throw new InputError(`Unsupported auth provider: ${value}.`, {
    suggestedAction: 'Use codex or claude.',
  });
}

/** Summarizes vendor status output without echoing account details such as email or organization. */
export function formatStatus(stdout: string, stderr: string, exitCode: number | null): string {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && 'loggedIn' in parsed) {
      const { loggedIn, authMethod } = parsed as { loggedIn: unknown; authMethod?: unknown };
      const method = typeof authMethod === 'string' && /^[\w.-]{1,40}$/u.test(authMethod) ? ` (${authMethod})` : '';
      return loggedIn === true ? `logged in${method}` : 'not logged in';
    }
  } catch {
    // Plain-text status output is handled below.
  }
  const detail = (stdout || stderr).trim().split(/\r?\n/u)[0] ?? '';
  return exitCode === 0 ? detail || 'logged in' : `not logged in${detail ? ` (${detail})` : ''}`;
}
