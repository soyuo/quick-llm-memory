import { readFileSync } from 'node:fs';
import { Command } from 'commander';

interface PackageMetadata {
  description: string;
  version: string;
}

const packageMetadata = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

export function createCli(): Command {
  return new Command()
    .name('qlm')
    .description(packageMetadata.description)
    .version(packageMetadata.version);
}
