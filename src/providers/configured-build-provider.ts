import { ConfigurationError } from '../config/error.js';
import type { Settings } from '../config/schema.js';
import { ClaudeCodeProvider, CodexCliProvider } from './cli-provider.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { AIProvider, EmbeddingProvider } from './provider.js';

export function createConfiguredBuildProvider(settings: Settings): AIProvider {
  const providerName = settings.ai?.provider ?? 'openai';
  if (providerName === 'codex-cli') return new CodexCliProvider();
  if (providerName === 'claude-code') return new ClaudeCodeProvider();
  return createConfiguredProvider(settings);
}

export function createConfiguredEmbeddingProvider(settings: Settings): EmbeddingProvider {
  const providerName = settings.ai?.provider ?? 'openai';
  if (providerName === 'codex-cli' || providerName === 'claude-code') {
    throw new ConfigurationError(`${providerName} does not provide embeddings.`, {
      suggestedAction: 'Use ai.provider openai with OPENAI_API_KEY for semantic search, or use lexical modes.',
    });
  }
  return createConfiguredProvider(settings);
}

function createConfiguredProvider(settings: Settings): OpenAICompatibleProvider {
  const providerName = settings.ai?.provider ?? 'openai';
  if (providerName !== 'openai' && providerName !== 'openai-compatible') {
    throw new ConfigurationError(`Unsupported AI provider for knowledge builds: ${providerName}.`, {
      suggestedAction: 'Set ai.provider to openai in config.yaml for this build command.',
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new ConfigurationError('The OPENAI_API_KEY environment variable is required.', {
      suggestedAction: 'Set OPENAI_API_KEY in the environment; the key is not stored in config.yaml.',
    });
  }

  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  return new OpenAICompatibleProvider({ baseUrl, apiKey, id: providerName });
}
