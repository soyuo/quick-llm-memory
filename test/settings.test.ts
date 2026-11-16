import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../src/config/error.js';
import { resolveSettingsPaths } from '../src/config/paths.js';
import { loadSettings } from '../src/config/settings.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveSettingsPaths', () => {
  it('uses Windows config and local data locations independently', () => {
    const paths = resolveSettingsPaths({
      platform: 'win32',
      env: { APPDATA: 'D:\\UserConfig', LOCALAPPDATA: 'E:\\UserData' },
      homeDir: 'C:\\Users\\tester',
      cwd: 'C:\\repo',
    });

    expect(paths.configDir).toBe(
      win32.join('D:\\UserConfig', 'quick-llm-memory', 'config'),
    );
    expect(paths.configFile).toBe(
      win32.join(paths.configDir, 'config.yaml'),
    );
    expect(paths.dataRoot).toBe(
      win32.join('E:\\UserData', 'quick-llm-memory'),
    );
  });

  it('honors QLM_HOME for data without moving the config file', () => {
    const paths = resolveSettingsPaths({
      platform: 'linux',
      env: { QLM_HOME: 'custom-data' },
      homeDir: '/home/tester',
      cwd: '/work/project',
    });

    expect(paths.dataRoot).toBe(posix.resolve('/work/project', 'custom-data'));
    expect(paths.configDir).toBe(
      posix.join('/home/tester', '.config', 'quick-llm-memory', 'config'),
    );
  });

  it('uses macOS and Linux defaults and honors absolute XDG paths', () => {
    const macPaths = resolveSettingsPaths({
      platform: 'darwin',
      env: {},
      homeDir: '/Users/tester',
    });
    const linuxPaths = resolveSettingsPaths({
      platform: 'linux',
      env: {
        XDG_CONFIG_HOME: '/config-home',
        XDG_DATA_HOME: '/data-home',
      },
      homeDir: '/home/tester',
    });

    expect(macPaths.configDir).toBe(
      '/Users/tester/Library/Preferences/quick-llm-memory/config',
    );
    expect(macPaths.dataRoot).toBe(
      '/Users/tester/Library/Application Support/quick-llm-memory',
    );
    expect(linuxPaths.configDir).toBe(
      '/config-home/quick-llm-memory/config',
    );
    expect(linuxPaths.dataRoot).toBe('/data-home/quick-llm-memory');
  });
});

describe('loadSettings', () => {
  it('loads YAML settings and applies defaults for missing optional values', () => {
    const paths = createSettingsPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      paths.configFile,
      'application:\n  name: quick-llm-memory\nlogging: {}\nai:\n  provider: openai\n',
    );

    const settings = loadSettings({ paths });

    expect(settings.logging.level).toBe('info');
    expect(settings.application).toEqual({ name: 'quick-llm-memory' });
    expect(settings.ai).toEqual({ provider: 'openai' });
  });

  it('uses defaults when the config file is missing', () => {
    const settings = loadSettings({ paths: createSettingsPaths() });

    expect(settings.logging.level).toBe('info');
  });

  it('returns a typed configuration error for invalid settings', () => {
    const paths = createSettingsPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, 'logging:\n  level: verbose\n');

    expect(() => loadSettings({ paths })).toThrow(ConfigurationError);
    expect(() => loadSettings({ paths })).toThrow(/logging\.level/);
  });

  it('returns a typed configuration error for invalid YAML', () => {
    const paths = createSettingsPaths();
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configFile, 'logging: [\n');

    expect(() => loadSettings({ paths })).toThrow(ConfigurationError);
    expect(() => loadSettings({ paths })).toThrow(/Unable to parse settings file/);
  });
});

function createSettingsPaths() {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-settings-'));
  temporaryDirectories.push(directory);

  return {
    dataRoot: directory,
    configDir: directory,
    configFile: join(directory, 'config.yaml'),
  };
}
