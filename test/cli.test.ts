import { readFileSync } from 'node:fs';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { createCli } from '../src/cli.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function runCli(args: string[]): { exitCode: number; output: string } {
  const output: string[] = [];
  const cli = createCli();
  cli.configureOutput({ writeOut: (text) => output.push(text) });
  cli.exitOverride();

  try {
    cli.parse(['node', 'qlm', ...args]);
  } catch (error) {
    if (!(error instanceof CommanderError)) {
      throw error;
    }

    return { exitCode: error.exitCode, output: output.join('') };
  }

  return { exitCode: 0, output: output.join('') };
}

describe('CLI', () => {
  it('prints help and exits successfully', () => {
    const result = runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Usage: qlm [options]');
  });

  it('prints the package version', () => {
    const result = runCli(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe(version);
  });
});
