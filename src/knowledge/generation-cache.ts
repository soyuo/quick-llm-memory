import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AIProvider, StructuredRequest } from '../providers/provider.js';

const CACHE_VERSION = 1;
const PROMPT_VERSION = 1;
const SCHEMA_VERSION = 1;
const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_ENTRY_BYTES = 512 * 1024;

export interface GenerationCacheOptions {
  dataRoot: string;
  projectId: string;
  enabled?: boolean;
}

export interface CachedGenerationRequest<T> {
  provider: AIProvider;
  request: StructuredRequest<T>;
  sourceContentHash: string;
  options?: GenerationCacheOptions;
  validate: (value: unknown) => T;
}

/** Reuse validated structured document responses without persisting prompts or credentials. */
export async function generateStructuredWithCache<T>(
  input: CachedGenerationRequest<T>,
): Promise<T> {
  const { provider, request, validate, options } = input;
  if (options?.enabled === false) {
    return validate(await provider.generateStructured<T>(request));
  }

  const cacheKey = createCacheKey(input);
  const cacheDirectory = options === undefined
    ? undefined
    : ensureCacheDirectory(options.dataRoot, options.projectId);
  if (cacheDirectory !== undefined) {
    const cached = readCacheEntry(cacheDirectory, cacheKey, validate);
    if (cached.found) return cached.value;
  }

  const response = validate(await provider.generateStructured<T>(request));
  if (cacheDirectory !== undefined) writeCacheEntry(cacheDirectory, cacheKey, response);
  return response;
}

function createCacheKey<T>(input: CachedGenerationRequest<T>): string {
  const { provider, request, sourceContentHash } = input;
  const keyMaterial = {
    cacheVersion: CACHE_VERSION,
    sourceContentHash,
    provider: provider.id,
    providerIdentity: provider.cacheIdentity ?? provider.id,
    model: request.model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    generationOptions: {
      temperature: request.temperature ?? 0,
      maxTokens: request.maxTokens ?? null,
    },
    schemaName: request.schemaName ?? null,
    promptHash: digest(request.prompt),
    systemPromptHash: digest(request.systemPrompt ?? ''),
    schemaHash: digest(stableStringify(request.schema)),
  };
  return digest(JSON.stringify(keyMaterial));
}

function readCacheEntry<T>(
  directory: string,
  key: string,
  validate: (value: unknown) => T,
): { found: true; value: T } | { found: false } {
  const filePath = join(directory, `${key}.json`);
  try {
    const fileInfo = lstatSync(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > MAX_CACHE_ENTRY_BYTES) {
      removeCacheFile(filePath);
      return { found: false };
    }
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!isCacheEntry(parsed, key)) {
      removeCacheFile(filePath);
      return { found: false };
    }
    try {
      const value = validate(parsed.response);
      utimesSync(filePath, new Date(), new Date());
      return { found: true, value };
    } catch {
      removeCacheFile(filePath);
      return { found: false };
    }
  } catch {
    return { found: false };
  }
}

function writeCacheEntry(directory: string, key: string, response: unknown): void {
  const filePath = join(directory, `${key}.json`);
  const temporaryPath = join(directory, `.qlm-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    const serialized = JSON.stringify({ cacheVersion: CACHE_VERSION, key, response });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CACHE_ENTRY_BYTES) return;
    if (existsSync(filePath)) {
      const existing = lstatSync(filePath);
      if (!existing.isFile() || existing.isSymbolicLink()) return;
    }
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, filePath);
    pruneCache(directory);
  } catch {
    // Cache failures must not prevent a valid build from completing.
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    removeCacheFile(temporaryPath);
  }
}

function ensureCacheDirectory(dataRoot: string, projectId: string): string | undefined {
  try {
    if (!/^[A-Za-z0-9-]{1,80}$/u.test(projectId)) return undefined;
    const rootInfo = lstatSync(dataRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return undefined;
    let current = dataRoot;
    for (const name of ['cache', 'generation', projectId]) {
      current = join(current, name);
      if (existsSync(current)) {
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
      } else {
        mkdirSync(current);
        const info = lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
      }
    }
    pruneCache(current);
    return current;
  } catch {
    return undefined;
  }
}

function pruneCache(directory: string): void {
  try {
    const names = readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/u.test(name));
    if (names.length <= MAX_CACHE_ENTRIES) return;
    const entries = names
      .flatMap((name) => {
        const filePath = join(directory, name);
        const info = lstatSync(filePath);
        return info.isFile() && !info.isSymbolicLink()
          ? [{ filePath, modifiedAt: info.mtimeMs }]
          : [];
      })
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_CACHE_ENTRIES))) {
      removeCacheFile(entry.filePath);
    }
  } catch {
    // A failed prune leaves older entries in place; lookup and writes remain bounded per entry.
  }
}

function isCacheEntry(value: unknown, key: string): value is { response: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry).sort();
  return keys.length === 3 && keys[0] === 'cacheVersion' && keys[1] === 'key' && keys[2] === 'response' &&
    entry.cacheVersion === CACHE_VERSION && entry.key === key && /^[0-9a-f]{64}$/u.test(key);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value) ?? 'null';
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function removeCacheFile(filePath: string): void {
  try {
    const info = lstatSync(filePath);
    if (info.isFile() && !info.isSymbolicLink()) unlinkSync(filePath);
  } catch {
    // Missing or inaccessible cache files are treated as cache misses.
  }
}
