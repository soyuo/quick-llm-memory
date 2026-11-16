import { readFileSync } from 'node:fs';

export interface PackageMetadata {
  description: string;
  version: string;
}

export const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;
