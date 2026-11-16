import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { parse as parseYaml } from 'yaml';
import { ConfigurationError } from './error.js';
import {
  resolveSettingsPaths,
  type ResolveSettingsPathsOptions,
  type SettingsPaths,
} from './paths.js';
import { settingsSchema, type Settings } from './schema.js';

export interface LoadSettingsOptions extends ResolveSettingsPathsOptions {
  paths?: SettingsPaths;
}

export function loadSettings(options: LoadSettingsOptions = {}): Settings {
  const paths = options.paths ?? resolveSettingsPaths(options);
  let contents: string;

  try {
    contents = readFileSync(paths.configFile, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return settingsSchema.parse({});
    }

    throw new ConfigurationError(
      `Unable to read settings file: ${paths.configFile}`,
      {
        filePath: paths.configFile,
        cause: error,
        suggestedAction: 'Check that the settings file is readable.',
      },
    );
  }

  let rawSettings: unknown;
  try {
    rawSettings = contents.trim() === '' ? {} : parseYaml(contents);
  } catch (error) {
    throw new ConfigurationError(
      `Unable to parse settings file: ${paths.configFile}`,
      {
        filePath: paths.configFile,
        cause: error,
        suggestedAction: 'Correct the YAML syntax in the settings file.',
      },
    );
  }

  try {
    return settingsSchema.parse(rawSettings);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');

      throw new ConfigurationError(
        `Invalid settings in ${paths.configFile}: ${details}`,
        { filePath: paths.configFile, cause: error },
      );
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
