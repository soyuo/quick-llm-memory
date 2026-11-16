import { InputError } from '../errors/qlm-error.js';
import { ProviderError } from './provider-error.js';
import type {
  AIProvider,
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  StructuredRequest,
  TokenCount,
} from './provider.js';

export interface OpenAICompatibleProviderOptions {
  /** API root, including a version prefix such as https://host.example/v1. */
  baseUrl: string;
  /** Bearer credential supplied by the caller; the adapter does not persist it. */
  apiKey: string;
  /** Optional fetch implementation for tests or a custom runtime. */
  fetch?: typeof globalThis.fetch;
  id?: string;
}

interface JsonObject {
  [key: string]: unknown;
}

interface ChatCompletionResult {
  model: string;
  text: string;
  usage?: GenerateResponse['usage'];
}

const DEFAULT_SCHEMA_NAME = 'qlm_response';

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleProviderOptions) {
    const baseUrl = parseBaseUrl(options.baseUrl);
    if (options.apiKey.trim().length === 0) {
      throw new InputError('An API key is required for this provider.');
    }

    this.id = options.id ?? 'openai-compatible';
    this.baseUrl = baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.request('/models', { method: 'GET' });
    if (!isJsonObject(payload) || !Array.isArray(payload.data)) {
      throw new ProviderError('Provider returned an invalid model list.');
    }

    return payload.data.map((model): ModelInfo => {
      if (!isJsonObject(model) || typeof model.id !== 'string' || model.id.length === 0) {
        throw new ProviderError('Provider returned a model without an ID.');
      }
      return { id: model.id };
    });
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    return this.complete(request);
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
    const name = request.schemaName ?? DEFAULT_SCHEMA_NAME;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new InputError('The structured response schema name is invalid.');
    }

    const result = await this.complete(request, {
      response_format: {
        type: 'json_schema',
        json_schema: { name, strict: true, schema: request.schema },
      },
    });

    try {
      return JSON.parse(result.text) as T;
    } catch (cause) {
      throw new ProviderError('Provider returned invalid structured JSON.', {
        cause,
      });
    }
  }

  async countTokens(text: string, model: string): Promise<TokenCount> {
    validateModel(model);
    return { count: Math.ceil(text.length / 4), isEstimate: true };
  }

  private async complete(
    request: GenerateRequest,
    additionalBody: JsonObject = {},
  ): Promise<ChatCompletionResult> {
    validateModel(request.model);

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (request.systemPrompt !== undefined) {
      messages.push({ role: 'system', content: request.systemPrompt });
    }
    messages.push({ role: 'user', content: request.prompt });

    const body: JsonObject = {
      ...additionalBody,
      model: request.model,
      messages,
    };
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    const payload = await this.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!isJsonObject(payload) || !Array.isArray(payload.choices)) {
      throw new ProviderError('Provider returned an invalid completion.');
    }

    const choice = payload.choices[0];
    if (
      !isJsonObject(choice) ||
      !isJsonObject(choice.message) ||
      typeof choice.message.content !== 'string'
    ) {
      throw new ProviderError('Provider returned no text completion.');
    }

    const responseModel =
      typeof payload.model === 'string' ? payload.model : request.model;
    const usage = readUsage(payload.usage);
    return {
      model: responseModel,
      text: choice.message.content,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.apiKey}`);
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        ...init,
        headers,
      });
    } catch (cause) {
      throw new ProviderError('Provider request failed before a response was received.', {
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      throw new ProviderError(`Provider returned HTTP ${response.status}.`, {
        statusCode: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    try {
      return await response.json();
    } catch (cause) {
      throw new ProviderError('Provider returned an invalid JSON response.', {
        statusCode: response.status,
        cause,
      });
    }
  }
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InputError('The provider base URL must be a valid HTTP or HTTPS URL.');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new InputError('The provider base URL must not contain credentials, a query, or a fragment.');
  }

  return value.replace(/\/+$/, '');
}

function validateModel(model: string): void {
  if (model.trim().length === 0) {
    throw new InputError('A model ID is required for this provider request.');
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readUsage(value: unknown): GenerateResponse['usage'] {
  if (
    !isJsonObject(value) ||
    typeof value.prompt_tokens !== 'number' ||
    typeof value.completion_tokens !== 'number'
  ) {
    return undefined;
  }
  return {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
  };
}

