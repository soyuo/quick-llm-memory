export interface ModelInfo {
  id: string;
  name?: string;
}

export interface GenerateRequest {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResponse {
  model: string;
  text: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export interface StructuredRequest<T> extends GenerateRequest {
  schema: JsonSchema;
  schemaName?: string;
}

export interface TokenCount {
  count: number;
  isEstimate: boolean;
}

export interface AIProvider {
  id: string;

  listModels(): Promise<ModelInfo[]>;

  generate(request: GenerateRequest): Promise<GenerateResponse>;

  generateStructured<T>(request: StructuredRequest<T>): Promise<T>;

  countTokens(text: string, model: string): Promise<TokenCount>;
}

export interface EmbeddingProvider {
  id: string;

  embed(texts: string[], model: string): Promise<number[][]>;
}
