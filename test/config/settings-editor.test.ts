import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { ConfigurationError } from '../../src/config/error.js';
import { loadSettings } from '../../src/config/settings.js';
import { updateSettings, type EditableSettingsValues } from '../../src/config/settings-editor.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('updateSettings', () => {
  it('persists supported settings and preserves unrelated configuration', () => {
    const paths = createPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, [
      'application: {name: quick-llm-memory}',
      'ai:',
      '  provider: openai',
      '  model: old-model',
      '  future_option: true',
      'logging:',
      '  level: info',
      '  format: json',
    ].join('\n'));

    updateSettings({ provider: 'openai-compatible', model: 'new-model', embeddingModel: 'embedding-v2', cacheGeneration: false, loggingLevel: 'debug' }, { paths });

    expect(loadSettings({ paths })).toMatchObject({
      application: { name: 'quick-llm-memory' },
      ai: { provider: 'openai-compatible', model: 'new-model', embedding_model: 'embedding-v2', cache_generation: false, future_option: true },
      logging: { level: 'debug' },
    });
    expect(parseYaml(readFileSync(paths.configFile, 'utf8'))).toMatchObject({
      logging: { level: 'debug', format: 'json' },
    });
  });

  it('creates a valid config when none exists and clears an optional model', () => {
    const paths = createPaths();

    updateSettings({ provider: 'openai', model: '', embeddingModel: 'text-embedding-3-small', cacheGeneration: true, loggingLevel: 'warn' }, { paths });

    expect(loadSettings({ paths })).toMatchObject({
      ai: { provider: 'openai', embedding_model: 'text-embedding-3-small', cache_generation: true },
      logging: { level: 'warn' },
    });
    expect(loadSettings({ paths }).ai?.model).toBeUndefined();
  });

  it('validates embedding model names independently from the chat model', () => {
    const paths = createPaths();
    expect(() => updateSettings({
      provider: 'openai',
      model: 'chat-model',
      embeddingModel: '   ',
      cacheGeneration: true,
      loggingLevel: 'info',
    }, { paths })).toThrow(/embedding_model/);
    expect(() => updateSettings({
      provider: 'openai',
      model: 'chat-model',
      embeddingModel: 'embedding\nmodel',
      cacheGeneration: true,
      loggingLevel: 'info',
    }, { paths })).toThrow(/terminal control characters/);
  });

  it('rejects invalid values and credential-bearing config without changing the file', () => {
    const paths = createPaths();
    mkdirSync(paths.configDir, { recursive: true });
    const original = 'ai:\n  provider: openai\n  api_key: do-not-show\nlogging:\n  level: info\n';
    writeFileSync(paths.configFile, original);

    expect(() => updateSettings({
      provider: 'invalid-provider' as EditableSettingsValues['provider'],
      model: 'model',
      cacheGeneration: true,
      embeddingModel: 'embedding-model',
      loggingLevel: 'info',
    }, { paths })).toThrow();
    expect(() => updateSettings({ provider: 'openai', model: 'model', embeddingModel: 'embedding-model', cacheGeneration: true, loggingLevel: 'info' }, { paths }))
      .toThrow(ConfigurationError);
    expect(() => updateSettings({ provider: 'openai', model: 'model', embeddingModel: 'embedding-model', cacheGeneration: true, loggingLevel: 'info' }, { paths }))
      .toThrow(/credentials/);
    expect(readFileSync(paths.configFile, 'utf8')).toBe(original);
    expect(JSON.stringify(parseYaml(readFileSync(paths.configFile, 'utf8')))).toContain('do-not-show');
  });
});

function createPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-settings-editor-'));
  temporaryDirectories.push(directory);
  const configDir = join(directory, 'config');
  return {
    dataRoot: join(directory, 'data'),
    configDir,
    configFile: join(configDir, 'config.yaml'),
  };
}
