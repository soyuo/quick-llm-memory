import { describe, expect, it } from 'vitest';
import { QLM_ERROR_CODES, InputError } from '../src/errors/qlm-error.js';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
} from '../src/providers/openai-compatible-provider.js';
import { ProviderError } from '../src/providers/provider-error.js';

describe('OpenAI-compatible provider', () => {
  it('exposes a credential-free cache identity for the configured endpoint', () => {
    const first = new OpenAICompatibleProvider({
      baseUrl: 'https://first.provider.example/v1',
      apiKey: 'test-secret',
    });
    const second = new OpenAICompatibleProvider({
      baseUrl: 'https://second.provider.example/v1',
      apiKey: 'test-secret',
    });

    expect(first.id).toBe(second.id);
    expect(first.cacheIdentity).not.toBe(second.cacheIdentity);
    expect(first.cacheIdentity).not.toContain('provider.example');
    expect(first.cacheIdentity).not.toContain('test-secret');
  });

  it('lists models using the configured endpoint and bearer key', async () => {
    let requestUrl = '';
    let authorization = '';
    const provider = createProvider({
      fetch: async (input, init) => {
        requestUrl = String(input);
        authorization = new Headers(init?.headers).get('authorization') ?? '';
        return jsonResponse({ data: [{ id: 'model-a' }, { id: 'model-b' }] });
      },
    });

    expect(await provider.listModels()).toEqual([
      { id: 'model-a' },
      { id: 'model-b' },
    ]);
    expect(requestUrl).toBe('https://provider.example/v1/models');
    expect(authorization).toBe('Bearer test-secret');
  });

  it('sends chat completion options and maps the response', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const provider = createProvider({
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          model: 'returned-model',
          choices: [{ message: { content: 'Generated text.' } }],
          usage: { prompt_tokens: 8, completion_tokens: 3 },
        });
      },
    });

    await expect(
      provider.generate({
        model: 'requested-model',
        systemPrompt: 'Be precise.',
        prompt: 'Explain this.',
        temperature: 0.2,
        maxTokens: 200,
      }),
    ).resolves.toEqual({
      model: 'returned-model',
      text: 'Generated text.',
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    expect(requestUrl).toBe('https://provider.example/v1/chat/completions');
    expect(requestBody).toMatchObject({
      model: 'requested-model',
      messages: [
        { role: 'system', content: 'Be precise.' },
        { role: 'user', content: 'Explain this.' },
      ],
      temperature: 0.2,
      max_tokens: 200,
    });
  });

  it('passes the JSON Schema to structured output and parses the result', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createProvider({
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          choices: [{ message: { content: '{"title":"Guide"}' } }],
        });
      },
    });

    await expect(
      provider.generateStructured<{ title: string }>({
        model: 'requested-model',
        prompt: 'Return a title.',
        schemaName: 'document_plan',
        schema: { type: 'object', properties: { title: { type: 'string' } } },
      }),
    ).resolves.toEqual({ title: 'Guide' });
    expect(requestBody?.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'document_plan',
        strict: true,
        schema: { type: 'object', properties: { title: { type: 'string' } } },
      },
    });
  });

  it('forwards an abort signal to the provider request', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | null | undefined;
    const provider = createProvider({
      fetch: async (_input, init) => {
        receivedSignal = init?.signal;
        return jsonResponse({
          choices: [{ message: { content: '{"title":"Guide"}' } }],
        });
      },
    });

    await provider.generateStructured<{ title: string }>({
      model: 'requested-model',
      prompt: 'Return a title.',
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      signal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });

  it('rejects non-JSON structured content with a typed provider error', async () => {
    const provider = createProvider({
      fetch: async () =>
        jsonResponse({ choices: [{ message: { content: 'not JSON' } }] }),
    });

    await expect(
      provider.generateStructured({
        model: 'model-a',
        prompt: 'Return an object.',
        schema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ code: QLM_ERROR_CODES.provider });
  });

  it('returns an explicit estimated token count without a network request', async () => {
    const provider = createProvider({
      fetch: async () => {
        throw new Error('fetch must not be called');
      },
    });

    await expect(provider.countTokens('12345', 'model-a')).resolves.toEqual({
      count: 2,
      isEstimate: true,
    });
  });

  it('maps HTTP failures to retry-aware provider errors without exposing response bodies', async () => {
    const provider = createProvider({
      fetch: async () =>
        new Response(JSON.stringify({ error: 'test-secret leaked by server' }), {
          status: 429,
        }),
    });

    const error = await provider.generate({ model: 'model-a', prompt: 'Hello' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      code: QLM_ERROR_CODES.provider,
      statusCode: 429,
      retryable: true,
    });
    expect((error as Error).message).not.toContain('test-secret');
  });

  it('rejects malformed model and completion responses with typed errors', async () => {
    const badModels = createProvider({ fetch: async () => jsonResponse({ data: [{}] }) });
    await expect(badModels.listModels()).rejects.toBeInstanceOf(ProviderError);

    const badCompletion = createProvider({
      fetch: async () => jsonResponse({ choices: [{ message: { content: 3 } }] }),
    });
    await expect(
      badCompletion.generate({ model: 'model-a', prompt: 'Hello' }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('wraps network failures and rejects invalid caller configuration', async () => {
    const unavailable = createProvider({
      fetch: async () => {
        throw new Error('network unavailable');
      },
    });
    await expect(
      unavailable.generate({ model: 'model-a', prompt: 'Hello' }),
    ).rejects.toMatchObject({ code: QLM_ERROR_CODES.provider, retryable: true });

    expect(
      () => new OpenAICompatibleProvider({ baseUrl: 'file:///tmp/api', apiKey: 'key' }),
    ).toThrow(InputError);
    expect(
      () => new OpenAICompatibleProvider({ baseUrl: 'https://provider.example/v1', apiKey: ' ' }),
    ).toThrow(InputError);
  });
});

function createProvider(
  overrides: Partial<OpenAICompatibleProviderOptions> = {},
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://provider.example/v1/',
    apiKey: 'test-secret',
    ...overrides,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
