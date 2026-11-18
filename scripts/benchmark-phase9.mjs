import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpus, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(root, 'dist', 'index.js');
const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-phase9-bench-'));
const env = { ...process.env, QLM_HOME: dataRoot, OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' };
const repetitions = 7;
const documentCount = 250;
const body = Array.from({ length: 48 }, (_, i) =>
  `Deterministic local benchmark paragraph ${i}. Searchneedle appears in every document for stable full-text retrieval. `,
).join('\n\n');

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function measure(args) {
  const start = performance.now();
  const stdout = run(args);
  return { ms: Number((performance.now() - start).toFixed(2)), stdout };
}

function profile(args) {
  const result = spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${dataRoot}`, cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 0, `profile ${args.join(' ')} failed: ${result.stderr}`);
  const profileName = readdirSync(dataRoot).find((name) => name.endsWith('.cpuprofile'));
  assert.ok(profileName, 'Node CPU profile was not generated');
  const cpuProfile = JSON.parse(readFileSync(join(dataRoot, profileName), 'utf8'));
  const samples = new Map();
  for (const id of cpuProfile.samples) {
    const node = cpuProfile.nodes.find((item) => item.id === id);
    if (node) samples.set(node.callFrame.functionName || '(anonymous)', (samples.get(node.callFrame.functionName || '(anonymous)') ?? 0) + 1);
  }
  rmSync(join(dataRoot, profileName));
  return [...samples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([functionName, ticks]) => ({ functionName, ticks }));
}

function summarize(values) {
  const warmSorted = values.slice(1).sort((a, b) => a - b);
  return {
    firstRunMs: values[0],
    warmMedianMs: Number(warmSorted[Math.floor(warmSorted.length / 2)].toFixed(2)),
    samplesMs: values,
  };
}

try {
  run(['init', 'phase9-benchmark']);
  const knowledge = join(dataRoot, 'projects', 'phase9-benchmark', 'knowledge', 'bench');
  mkdirSync(knowledge, { recursive: true });
  for (let i = 0; i < documentCount; i += 1) {
    const id = `bench-${String(i).padStart(4, '0')}`;
    writeFileSync(join(knowledge, `${id}.md`),
      `---\nschema_version: 1\nid: ${id}\ntitle: Benchmark ${i}\ntype: document\nstatus: active\ndepth: 1\n---\n\n${body}\n`,
    );
  }

  const startup = [];
  const indexing = [];
  const retrieval = [];
  const indexingProfileTopFunctions = profile(['reindex', '--project', 'phase9-benchmark', '--no-embeddings']);
  for (let i = 0; i < repetitions; i += 1) {
    startup.push(measure(['--version']).ms);
    const index = measure(['reindex', '--project', 'phase9-benchmark', '--no-embeddings']);
    indexing.push(index.ms);
    const search = measure(['search', 'Searchneedle', '--project', 'phase9-benchmark', '--mode', 'fulltext', '--max-results', '10']);
    assert.match(search.stdout, /Benchmark/);
    retrieval.push(search.ms);
  }

  console.log(JSON.stringify({
    benchmark: 'phase9-local-v1',
    generatedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cpu: cpus()[0]?.model,
    cpuCount: cpus().length,
    documentCount,
    documentBytes: Buffer.byteLength(body),
    warmupPolicy: 'first measured invocation is reported separately; remaining six are warm samples; report their median (OS filesystem cache is not flushed)',
    startup: summarize(startup),
    indexingWithoutEmbeddings: summarize(indexing),
    indexingProfileTopFunctions,
    fullTextRetrievalTop10: summarize(retrieval),
    correctness: 'each full-text search returned benchmark documents',
    network: 'no provider calls configured; indexing uses --no-embeddings',
  }, null, 2));
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
