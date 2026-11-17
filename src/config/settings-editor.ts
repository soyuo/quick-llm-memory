import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigurationError } from './error.js';
import {
  resolveSettingsPaths,
  type ResolveSettingsPathsOptions,
  type SettingsPaths,
} from './paths.js';
import { settingsSchema, type Settings } from './schema.js';

export interface EditableSettingsValues {
  provider: NonNullable<Settings['ai']>['provider'];
  model: string;
  embeddingModel: string;
  cacheGeneration: boolean;
  loggingLevel: Settings['logging']['level'];
}

export interface UpdateSettingsOptions extends ResolveSettingsPathsOptions {
  paths?: SettingsPaths;
}

export function updateSettings(
  values: EditableSettingsValues,
  options: UpdateSettingsOptions = {},
): Settings {
  const paths = options.paths ?? resolveSettingsPaths(options);
  const model = values.model.trim();
  const embeddingModel = values.embeddingModel.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(model) || /[\u0000-\u001f\u007f-\u009f]/.test(embeddingModel)) {
    throw new ConfigurationError('Model names cannot contain terminal control characters.', {
      filePath: paths.configFile,
    });
  }
  const candidate = settingsSchema.parse({
    ai: {
      provider: values.provider,
      embedding_model: embeddingModel,
      cache_generation: values.cacheGeneration,
      ...(model.length > 0 ? { model } : {}),
    },
    logging: { level: values.loggingLevel },
  });

  let raw: unknown = {};
  if (existsSync(paths.configFile)) {
    try {
      if (lstatSync(paths.configFile).isSymbolicLink()) {
        throw new ConfigurationError('Settings file must not be a symbolic link.', {
          filePath: paths.configFile,
        });
      }
      const contents = readFileSync(paths.configFile, 'utf8');
      raw = contents.trim().length === 0 ? {} : parseYaml(contents);
    } catch (cause) {
      if (cause instanceof ConfigurationError) {
        throw cause;
      }
      throw new ConfigurationError('Unable to read or parse application settings.', {
        filePath: paths.configFile,
        cause,
        suggestedAction: 'Check the settings file syntax and permissions.',
      });
    }
  }

  settingsSchema.parse(raw);
  const root = asRecord(raw);
  if (containsCredentialField(root)) {
    throw new ConfigurationError(
      'Settings containing credentials cannot be edited here; keep provider credentials in environment variables.',
      { filePath: paths.configFile },
    );
  }

  const rawAi = asRecord(root.ai);
  const ai: Record<string, unknown> = {
    ...rawAi,
    provider: candidate.ai?.provider ?? 'openai',
    cache_generation: candidate.ai?.cache_generation ?? true,
  };
  if (model.length > 0) {
    ai.model = model;
  } else {
    delete ai.model;
  }
  ai.embedding_model = embeddingModel;

  const next: Record<string, unknown> = {
    ...root,
    ai,
    logging: { ...asRecord(root.logging), level: candidate.logging.level },
  };
  const validated = settingsSchema.parse(next);

  try {
    mkdirSync(paths.configDir, { recursive: true });
    writeSettingsAtomically(paths.configFile, `${stringifyYaml(next).trimEnd()}\n`);
  } catch (cause) {
    if (cause instanceof ConfigurationError) {
      throw cause;
    }
    throw new ConfigurationError('Unable to save application settings.', {
      filePath: paths.configFile,
      cause,
      suggestedAction: 'Check that the settings directory is writable.',
    });
  }

  return validated;
}

function writeSettingsAtomically(filePath: string, contents: string): void {
  const temporaryPath = join(dirname(filePath), `.qlm-settings-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Keep the original write error.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw cause;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialField);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  return Object.entries(value).some(([key, nested]) => (
    /api.?key|access.?token|refresh.?token|secret|password|credential|authorization/i.test(key) ||
    containsCredentialField(nested)
  ));
}
