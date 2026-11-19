import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli.js';
import type { CliRunner } from '../../src/providers/cli-runner.js';

async function run(authRunner: CliRunner, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(
    ['node', 'qlm', 'auth', ...args],
    { writeOut: (text) => out.push(text), writeError: (text) => err.push(text) },
    { authRunner },
  );
  return { exitCode, out: out.join(''), err: err.join('') };
}

describe('qlm auth', () => {
  it('delegates browser login to the codex and claude CLIs', async () => {
    const runner = vi.fn<CliRunner>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));

    expect((await run(runner, 'login', 'codex')).exitCode).toBe(0);
    expect(runner).toHaveBeenLastCalledWith('codex', ['login'], { inherit: true });
    expect((await run(runner, 'login', 'codex', '--device')).exitCode).toBe(0);
    expect(runner).toHaveBeenLastCalledWith('codex', ['login', '--device-auth'], { inherit: true });
    expect((await run(runner, 'login', 'claude')).exitCode).toBe(0);
    expect(runner).toHaveBeenLastCalledWith('claude', ['auth', 'login'], { inherit: true });
  });

  it('rejects unknown providers and unsupported --device', async () => {
    const runner = vi.fn<CliRunner>();

    expect((await run(runner, 'login', 'gemini')).exitCode).toBe(1);
    expect((await run(runner, 'login', 'claude', '--device')).exitCode).toBe(1);
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports status for each CLI, including a missing CLI', async () => {
    const runner: CliRunner = async (command) => {
      if (command === 'claude') throw new Error('ENOENT');
      return { stdout: 'Logged in using ChatGPT\n', stderr: '', exitCode: 0 };
    };

    const result = await run(runner, 'status');

    expect(result.out).toContain('codex: Logged in using ChatGPT');
    expect(result.out).toContain('claude: ENOENT');
  });

  it('summarizes JSON status without exposing account details', async () => {
    const runner: CliRunner = async () => ({
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'person@example.com', orgName: 'Secret Org' }, null, 2),
      stderr: '',
      exitCode: 0,
    });

    const result = await run(runner, 'status', 'claude');

    expect(result.out).toBe('claude: logged in (claude.ai)\n');
  });

  it('redacts emails and hides JSON fragments in plain-text status output', async () => {
    const withEmail: CliRunner = async () => ({ stdout: 'Logged in as person@example.com\n', stderr: '', exitCode: 0 });
    const brokenJson: CliRunner = async () => ({ stdout: '{\n  "email": "person@example.com"\n', stderr: '', exitCode: 1 });

    const first = await run(withEmail, 'status', 'codex');
    const second = await run(brokenJson, 'status', 'claude');

    expect(first.out).toBe('codex: Logged in as [redacted]\n');
    expect(second.out).toBe('claude: not logged in\n');
    expect(first.out + second.out).not.toContain('person@example.com');
  });

  it('reports a logged-out JSON status', async () => {
    const runner: CliRunner = async () => ({ stdout: '{"loggedIn": false}', stderr: '', exitCode: 1 });

    expect((await run(runner, 'status', 'claude')).out).toBe('claude: not logged in\n');
  });

  it('fails when the vendor login does not complete', async () => {
    const runner: CliRunner = async () => ({ stdout: '', stderr: '', exitCode: 1 });

    const result = await run(runner, 'login', 'codex');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('did not complete');
  });
});
