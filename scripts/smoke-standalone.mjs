import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const packageDirectory = fileURLToPath(new URL('../standalone/', import.meta.url));
const executable = join(packageDirectory, process.platform === 'win32' ? 'qlm.cmd' : 'qlm');
const home = mkdtempSync(join(tmpdir(), 'qlm-standalone-smoke-'));
const require = createRequire(join(packageDirectory, 'package.json'));

function run(args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { ...process.env, QLM_HOME: home },
    shell: process.platform === 'win32',
    timeout: 30_000,
  });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

try {
  const { renameNoReplace } = require('./build/Release/qlm_rename_noreplace.node');
  const renameSource = join(home, 'rename-source');
  const renameDestination = join(home, 'rename-destination');
  mkdirSync(renameSource);
  renameNoReplace(renameSource, renameDestination);
  assert.equal(existsSync(renameSource), false);
  assert.equal(existsSync(renameDestination), true);

  assert.match(run(['--help']), /Usage: qlm/);
  assert.match(run(['--version']), /^0\.1\.0/m);
  run(['init', 'standalone-smoke']);
  assert.match(run(['project', 'list']), /standalone-smoke/);
  console.log(`Standalone smoke passed on ${process.platform}-${process.arch}.`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
