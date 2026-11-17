import { ConfigurationError } from '../config/error.js';
import type { Settings } from '../config/schema.js';
import { OpenAICompatibleProvider } from './openai-compatible-provider.js';
import type { AIProvider } from './provider.js';

export function createConfiguredBuildProvider(settings: Settings): AIProvider {
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
