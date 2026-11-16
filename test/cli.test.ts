import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reportCliError, runCli } from '../src/cli.js';
import { ConfigurationError } from '../src/config/error.js';
import { InputError, QLM_ERROR_CODES } from '../src/errors/qlm-error.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

async function runCommand(args: string[]): Promise<{
  exitCode: number;
  output: string;
  errorOutput: string;
}> {
  const output: string[] = [];
  const errorOutput: string[] = [];
  const exitCode = await runCli(['node', 'qlm', ...args], {
    writeOut: (text) => output.push(text),
    writeError: (text) => errorOutput.push(text),
  });

  return { exitCode, output: output.join(''), errorOutput: errorOutput.join('') };
}

describe('CLI', () => {
  it('prints help and exits successfully', async () => {
    const result = await runCommand(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage: qlm [options]');
  });

  it('prints the package version', async () => {
    const result = await runCommand(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(version);
  });

  it('returns a non-zero exit code for invalid options', async () => {
    const result = await runCommand(['--unknown-option']);

    expect(result.exitCode).toBe(1);
    expect(result.errorOutput).toContain("unknown option '--unknown-option'");
    expect(result.errorOutput).toContain('Run `qlm --help`');
  });

  it('formats expected application errors with guidance', () => {
    const output: string[] = [];
    const error = new ConfigurationError('Invalid logging level.', {
      filePath: 'config.yaml',
      suggestedAction: 'Choose a supported logging level.',
    });

    expect(reportCliError(error, (text) => output.push(text))).toBe(1);
    expect(output.join('')).toContain(`[${QLM_ERROR_CODES.configuration}]`);
    expect(output.join('')).toContain('Invalid logging level.');
    expect(output.join('')).toContain('Action: Choose a supported logging level.');
  });

  it('formats unexpected errors without exposing their internal message', () => {
    const output: string[] = [];

    expect(
      reportCliError(new Error('private implementation detail'), (text) =>
        output.push(text),
      ),
    ).toBe(1);
    expect(output.join('')).toContain(`[${QLM_ERROR_CODES.internal}]`);
    expect(output.join('')).toContain('An unexpected error occurred.');
    expect(output.join('')).toContain('Run `qlm --help`');
    expect(output.join('')).not.toContain('private implementation detail');
  });

  it('exposes stable input error codes and retry guidance fields', () => {
    const error = new InputError('A required value is missing.', {
      retryable: true,
      suggestedAction: 'Provide a project name.',
    });

    expect(error.code).toBe(QLM_ERROR_CODES.input);
    expect(error.retryable).toBe(true);
    expect(error.suggestedAction).toBe('Provide a project name.');
  });
});
