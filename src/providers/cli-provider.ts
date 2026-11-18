import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InputError } from '../errors/qlm-error.js';
import { runCli, type CliRunner } from './cli-runner.js';
import { ProviderError } from './provider-error.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from './provider.js';

export type CliProviderKind = 'codex-cli' | 'claude-code';

export interface CliProviderOptions {
  runner?: CliRunner;
  command?: string;
  timeoutMs?: number;
}

type JsonSchemaObject = Readonly<Record<string, unknown>>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

abstract class CliProvider implements AIProvider {
  abstract readonly id: CliProviderKind;
  readonly cacheIdentity: string;
  protected readonly runner: CliRunner;
  protected readonly command: string;
  protected readonly timeoutMs: number;

  constructor(kind: CliProviderKind, defaultCommand: string, options: CliProviderOptions) {
    this.cacheIdentity = kind;
    this.runner = options.runner ?? runCli;
    this.command = options.command ?? defaultCommand;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    validateModel(request.model);
    return { model: request.model, ...(await this.complete(request)) };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    validateModel(request.model);
    const { text } = await this.complete(request, request.schema);
    try {
      return JSON.parse(extractJson(text)) as T;
    } catch (cause) {
      throw new ProviderError('Provider returned invalid structured JSON.', { cause });
    }
  }

  async countTokens(text: string, model: string): Promise<TokenCount> {
    validateModel(model);
    return { count: Math.ceil(text.length / 4), isEstimate: true };
  }

  protected abstract complete(
    request: GenerateRequest,
    schema?: JsonSchemaObject,
  ): Promise<{ text: string; usage?: GenerateResponse['usage'] }>;

  protected failure(stderr: string, exitCode: number | null): ProviderError {
    const loginHint = /log(?:ged)? ?in|auth|credential|not signed/i.test(stderr)
      ? ' The subscription login may be missing or expired.'
      : '';
    return new ProviderError(`${this.id} exited with code ${exitCode ?? 'unknown'}.${loginHint}`, {
      suggestedAction: 'Run `qlm auth status` to check the subscription login, or `qlm auth login`.',
    });
  }
}

export class CodexCliProvider extends CliProvider {
  readonly id = 'codex-cli' as const;

  constructor(options: CliProviderOptions = {}) {
    super('codex-cli', 'codex', options);
  }

  protected async complete(request: GenerateRequest, schema?: JsonSchemaObject) {
    const directory = await mkdtemp(join(tmpdir(), 'qlm-codex-'));
    try {
      const outputFile = join(directory, 'last-message.txt');
      const args = [
        'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
        '-C', '.', '-m', request.model, '-o', 'last-message.txt',
      ];
      if (schema !== undefined) {
        await writeFile(join(directory, 'schema.json'), JSON.stringify(schema), 'utf8');
        args.push('--output-schema', 'schema.json');
      }
      args.push('-');
      const prompt = request.systemPrompt === undefined
        ? request.prompt
        : `${request.systemPrompt}\n\n${request.prompt}`;
      const result = await this.runner(this.command, args, {
        input: prompt,
        cwd: directory,
        timeoutMs: this.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      if (result.exitCode !== 0) throw this.failure(result.stderr, result.exitCode);
      const text = (await readFile(outputFile, 'utf8').catch(() => '')).trim();
      if (text.length === 0) throw new ProviderError('Provider returned no text completion.');
      return { text };
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
  }
}

export class ClaudeCodeProvider extends CliProvider {
  readonly id = 'claude-code' as const;

  constructor(options: CliProviderOptions = {}) {
    super('claude-code', 'claude', options);
  }

  protected async complete(request: GenerateRequest, schema?: JsonSchemaObject) {
    const system = [
      request.systemPrompt,
      schema === undefined
        ? undefined
        : `Respond with only a JSON value matching this JSON Schema, with no prose or code fences:\n${JSON.stringify(schema)}`,
    ].filter((part): part is string => part !== undefined).join('\n\n');
    const prompt = system.length === 0 ? request.prompt : `${system}\n\n${request.prompt}`;
    const directory = await mkdtemp(join(tmpdir(), 'qlm-claude-'));
    let result;
    try {
    result = await this.runner(
      this.command,
      ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', '--model', request.model],
      {
        input: prompt,
        cwd: directory,
        timeoutMs: this.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
    );
    } finally {
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    }
    if (result.exitCode !== 0) throw this.failure(result.stderr, result.exitCode);
    let payload: unknown;
    try {
      payload = JSON.parse(result.stdout);
    } catch (cause) {
      throw new ProviderError('Provider returned an invalid JSON response.', { cause });
    }
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    if (record.is_error === true || typeof record.result !== 'string' || record.result.trim().length === 0) {
      throw new ProviderError('Provider returned no text completion.');
    }
    const usage = record.usage as { input_tokens?: unknown; output_tokens?: unknown } | undefined;
    return {
      text: record.result.trim(),
      ...(typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {}),
    };
  }
}

function validateModel(model: string): void {
  if (!MODEL_PATTERN.test(model)) {
    throw new InputError('The model name is invalid for a CLI provider.', {
      suggestedAction: 'Use letters, digits, dots, colons, underscores, and hyphens only.',
    });
  }
}

function extractJson(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return fenced?.[1] ?? text.trim();
}
