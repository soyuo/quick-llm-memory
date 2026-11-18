import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporaryRoot = mkdtempSync(join(tmpdir(), 'qlm-npm-smoke-'));
const packDirectory = join(temporaryRoot, 'pack');
const consumerDirectory = join(temporaryRoot, 'consumer');
const dataRoot = join(temporaryRoot, 'data');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
    shell: process.platform === 'win32',
    ...options,
  });
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

try {
  mkdirSync(packDirectory);
  mkdirSync(consumerDirectory);
  const packResult = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDirectory]));
  const tarball = join(packDirectory, packResult[0].filename);
  run('npm', ['install', '--prefix', consumerDirectory, '--no-save', tarball]);

  const windows = process.platform === 'win32';
  const binary = join(consumerDirectory, 'node_modules', '.bin', windows ? 'qlm.cmd' : 'qlm');
  const env = { ...process.env, QLM_HOME: dataRoot };
  assert.match(run(binary, ['--help'], { env }), /Usage: qlm/);
  assert.match(run(binary, ['--version'], { env }), /^0\.1\.0/m);
  run(binary, ['init', 'npm-smoke'], { env });
  assert.match(run(binary, ['project', 'list'], { env }), /npm-smoke/);
  console.log(`npm tarball install smoke passed on ${process.platform}-${process.arch}.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
