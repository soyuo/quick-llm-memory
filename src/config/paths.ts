import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { ConfigurationError } from './error.js';

export interface SettingsPaths {
  dataRoot: string;
  configDir: string;
  configFile: string;
}

export interface ResolveSettingsPathsOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cwd?: string;
}

export function resolveSettingsPaths(
  options: ResolveSettingsPathsOptions = {},
): SettingsPaths {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();

  if (platform === 'win32') {
    const path = win32;
    const configBase = absoluteEnvPath(
      env.APPDATA,
      path,
      path.join(homeDir, 'AppData', 'Roaming'),
    );
    const dataBase = absoluteEnvPath(
      env.LOCALAPPDATA,
      path,
      path.join(homeDir, 'AppData', 'Local'),
    );

    return buildSettingsPaths(
      path,
      configBase,
      dataBase,
      env.QLM_HOME,
      cwd,
    );
  }

  if (platform === 'darwin') {
    const path = posix;
    const configBase = path.join(homeDir, 'Library', 'Preferences');
    const dataBase = path.join(homeDir, 'Library', 'Application Support');

    return buildSettingsPaths(
      path,
      configBase,
      dataBase,
      env.QLM_HOME,
      cwd,
    );
  }

  if (platform === 'linux') {
    const path = posix;
    const configBase = absoluteEnvPath(
      env.XDG_CONFIG_HOME,
      path,
      path.join(homeDir, '.config'),
    );
    const dataBase = absoluteEnvPath(
      env.XDG_DATA_HOME,
      path,
      path.join(homeDir, '.local', 'share'),
    );

    return buildSettingsPaths(
      path,
      configBase,
      dataBase,
      env.QLM_HOME,
      cwd,
    );
  }

  throw new ConfigurationError(`Unsupported operating system: ${platform}`);
}

function buildSettingsPaths(
  path: typeof posix | typeof win32,
  configBase: string,
  dataBase: string,
  dataRootOverride: string | undefined,
  cwd: string,
): SettingsPaths {
  const dataRoot =
    dataRootOverride && dataRootOverride.trim() !== ''
      ? path.resolve(cwd, dataRootOverride)
      : path.join(dataBase, 'quick-llm-memory');
  const configDir = path.join(
    configBase,
    'quick-llm-memory',
    'config',
  );

  return {
    dataRoot,
    configDir,
    configFile: path.join(configDir, 'config.yaml'),
  };
}

function absoluteEnvPath(
  value: string | undefined,
  path: typeof posix | typeof win32,
  fallback: string,
): string {
  return value !== undefined && path.isAbsolute(value) ? value : fallback;
}
