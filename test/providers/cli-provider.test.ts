import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeProvider, CodexCliProvider } from '../../src/providers/cli-provider.js';
import type { CliRunner } from '../../src/providers/cli-runner.js';
import { createConfiguredBuildProvider, createConfiguredEmbeddingProvider } from '../../src/providers/configured-build-provider.js';
import { settingsSchema } from '../../src/config/schema.js';

describe('Codex CLI provider', () => {
  it('runs codex exec read-only with the prompt on stdin and reads the last message', async () => {
    const runner = vi.fn<CliRunner>(async (_command, args, options) => {
      writeFileSync(args[args.indexOf('-o') + 1]!, 'generated text\n');
      expect(options?.input).toBe('system\n\nhello');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const provider = new CodexCliProvider({ runner });

    const response = await provider.generate({ model: 'gpt-5', prompt: 'hello', systemPrompt: 'system' });

    expect(response.text).toBe('generated text');
    const args = runner.mock.calls[0]![1];
    expect(runner.mock.calls[0]![0]).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only', '--ephemeral', '-m', 'gpt-5', '-']));
    expect(args.join(' ')).not.toContain('hello');
  });

  it('passes a schema file and parses structured output', async () => {
    const runner = vi.fn<CliRunner>(async (_command, args) => {
      expect(args).toContain('--output-schema');
      writeFileSync(args[args.indexOf('-o') + 1]!, '{"ok":true}');
      return { stdout: '', stderr: '', exitCode: 0 };
    });
    const provider = new CodexCliProvider({ runner });

    await expect(provider.generateStructured<{ ok: boolean }>({
      model: 'gpt-5', prompt: 'x', schema: { type: 'object' },
    })).resolves.toEqual({ ok: true });
  });

  it('reports a login hint when codex fails', async () => {
    const runner: CliRunner = async () => ({ stdout: '', stderr: 'Not logged in', exitCode: 1 });
    const provider = new CodexCliProvider({ runner });

    await expect(provider.generate({ model: 'gpt-5', prompt: 'x' })).rejects.toThrow(/login/);
  });

  it('rejects model names that could alter the command line', async () => {
    const provider = new CodexCliProvider({ runner: vi.fn<CliRunner>() });

    await expect(provider.generate({ model: 'x" & calc', prompt: 'x' })).rejects.toThrow(/model name/);
  });
});

describe('Claude Code provider', () => {
  it('runs claude -p without tools and parses the JSON result', async () => {
    const runner = vi.fn<CliRunner>(async () => ({
      stdout: JSON.stringify({ result: 'hi there', usage: { input_tokens: 3, output_tokens: 2 } }),
      stderr: '',
      exitCode: 0,
    }));
    const provider = new ClaudeCodeProvider({ runner });

    const response = await provider.generate({ model: 'sonnet', prompt: 'hello' });

    expect(response).toMatchObject({ text: 'hi there', usage: { inputTokens: 3, outputTokens: 2 } });
    expect(runner.mock.calls[0]![1]).toEqual(expect.arrayContaining(['-p', '--no-session-persistence', '--tools', '', '--model', 'sonnet']));
    expect(runner.mock.calls[0]![2]?.input).toBe('hello');
  });

  it('strips code fences from structured output and embeds the schema in the prompt', async () => {
    const runner = vi.fn<CliRunner>(async () => ({
      stdout: JSON.stringify({ result: '```json\n{"a":1}\n```' }),
      stderr: '',
      exitCode: 0,
    }));
    const provider = new ClaudeCodeProvider({ runner });

    await expect(provider.generateStructured<{ a: number }>({
      model: 'sonnet', prompt: 'x', schema: { type: 'object' },
    })).resolves.toEqual({ a: 1 });
    expect(runner.mock.calls[0]![2]?.input).toContain('"type":"object"');
  });

  it('fails on error results', async () => {
    const runner: CliRunner = async () => ({ stdout: JSON.stringify({ is_error: true, result: 'boom' }), stderr: '', exitCode: 0 });

    await expect(new ClaudeCodeProvider({ runner }).generate({ model: 'sonnet', prompt: 'x' })).rejects.toThrow(/no text/);
  });
});

describe('configured providers', () => {
  it('selects the CLI providers and refuses embeddings for them', () => {
    const codex = settingsSchema.parse({ ai: { provider: 'codex-cli' } });
    const claude = settingsSchema.parse({ ai: { provider: 'claude-code' } });

    expect(createConfiguredBuildProvider(codex).id).toBe('codex-cli');
    expect(createConfiguredBuildProvider(claude).id).toBe('claude-code');
    expect(() => createConfiguredEmbeddingProvider(codex)).toThrow(/embeddings/);
  });
});
