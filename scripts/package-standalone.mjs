import { cp, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = resolve(process.argv[2] ?? join(repositoryRoot, 'standalone'));
const platform = `${process.platform}-${process.arch}`;
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
);

await mkdir(outputDirectory, { recursive: true });
for (const entry of [
  'dist', 'docs', 'LICENSE', 'package.json', 'node_modules',
  'build',
]) {
  await cp(join(repositoryRoot, entry), join(outputDirectory, entry), {
    recursive: true,
  });
}

const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await cp(process.execPath, join(outputDirectory, nodeName));

const windows = process.platform === 'win32';
const launcherPath = join(outputDirectory, windows ? 'qlm.cmd' : 'qlm');
const launcher = windows
  ? '@echo off\r\n"%~dp0node.exe" "%~dp0dist\\index.js" %*\r\n'
  : '#!/bin/sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$DIR/node" "$DIR/dist/index.js" "$@"\n';
await writeFile(launcherPath, launcher, 'utf8');
if (!windows) await chmod(launcherPath, 0o755);

console.log(`Packaged ${packageJson.name}@${packageJson.version} for ${platform} at ${basename(outputDirectory)}`);
