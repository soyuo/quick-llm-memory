import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const repositoryRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-verification-'));
const dataRoot = join(temporaryRoot, 'data');
const outsideFile = join(temporaryRoot, 'outside.md');
const cliPath = join(repositoryRoot, 'dist', 'index.js');
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA)$/i.test(key)),
);
environment.QLM_HOME = dataRoot;
environment.APPDATA = join(temporaryRoot, 'appdata');
const networkGuard = pathToFileURL(join(repositoryRoot, 'scripts', 'verify-no-network.mjs')).href;
environment.NODE_OPTIONS = [environment.NODE_OPTIONS, `--import=${networkGuard}`].filter(Boolean).join(' ');
const runCli = (...args) => execFileSync(process.execPath, [cliPath, ...args], {
  cwd: repositoryRoot,
  env: environment,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

let transport;
let client;
let serverStderr = '';

try {
  runCli('init', 'demo');
  const settingsPath = join(environment.APPDATA, 'quick-llm-memory', 'config', 'config.yaml');
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, 'mcp:\n  permissions:\n    - READ\n    - SEARCH\n    - METADATA\n    - PROPOSE_WRITE\n', 'utf8');

  const projectRoot = join(dataRoot, 'projects', 'demo');
  const documentPath = join(projectRoot, 'knowledge', 'security', 'overview.md');
  mkdirSync(dirname(documentPath), { recursive: true });
  writeFileSync(documentPath, [
    '---',
    'schema_version: 1',
    'id: verification-overview',
    'title: MCP verification',
    'depth: 1',
    'type: document',
    'status: draft',
    'category: security',
    'tags:',
    '  - verification',
    'source_ids: []',
    'source_sections: []',
    'related: []',
    '---',
    '# MCP verification',
    '',
    'Deterministic local protocol fixture for MCP integration checks.',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(outsideFile, '# Outside\n\nThis file must never be exposed.\n', 'utf8');
  runCli('reindex', '--project', 'demo', '--no-embeddings');

  const databasePath = join(projectRoot, 'index', 'knowledge.db');
  const initialMarkdown = readFileSync(documentPath);
  const initialDatabase = readFileSync(databasePath);
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'mcp', 'serve', '--transport', 'stdio'],
    cwd: repositoryRoot,
    env: environment,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => { serverStderr += chunk.toString(); });
  client = new Client({ name: 'qlm-mcp-verification', version: '1.0.0' });
  await client.connect(transport);
  await client.ping();

  const { tools } = await client.listTools();
  const toolNames = tools.map(({ name }) => name).sort();
  assert.deepEqual(toolNames, [
    'memory_get_context', 'memory_get_metadata', 'memory_get_related',
    'memory_get_tree', 'memory_list_projects', 'memory_propose_document_update', 'memory_read', 'memory_read_many',
    'memory_search', 'memory_validate',
  ]);
  assert.ok(tools.filter(({ name }) => name !== 'memory_propose_document_update')
    .every((tool) => tool.annotations?.readOnlyHint === true));
  assert.equal(tools.find(({ name }) => name === 'memory_propose_document_update')?.annotations?.readOnlyHint, false);

  const projectList = await client.callTool({ name: 'memory_list_projects', arguments: {} });
  assert.equal(projectList.isError, undefined);
  assert.deepEqual(projectList.structuredContent?.projects?.map(({ name }) => name), ['demo']);
  const tree = await client.callTool({
    name: 'memory_get_tree', arguments: { project: 'demo', maxDepth: 2 },
  });
  assert.equal(tree.isError, undefined);
  assert.match(JSON.stringify(tree.structuredContent), /security\/overview\.md/);
  const search = await client.callTool({
    name: 'memory_search',
    arguments: { project: 'demo', query: 'verification', mode: 'fulltext' },
  });
  assert.equal(search.isError, undefined);
  assert.match(JSON.stringify(search.structuredContent), /security\/overview\.md/);
  const document = await client.callTool({
    name: 'memory_read', arguments: { project: 'demo', path: 'security/overview.md' },
  });
  assert.equal(document.isError, undefined);
  assert.match(JSON.stringify(document.structuredContent ?? document.content), /MCP verification/);

  const proposal = await client.callTool({
    name: 'memory_propose_document_update',
    arguments: {
      project: 'demo', path: 'security/overview.md',
      metadata: {
        schema_version: 1, title: 'Reviewed proposal title', depth: 1,
        type: 'document', status: 'draft', category: 'security',
        tags: ['verification'], source_ids: [], source_sections: [], related: [],
      },
      body: '# MCP verification\n\nProposed but not applied.\n',
    },
  });
  assert.equal(proposal.isError, undefined, JSON.stringify(proposal));
  assert.match(JSON.stringify(proposal), /Reviewed proposal title/);
  assert.deepEqual(readFileSync(documentPath), initialMarkdown);

  const { resources } = await client.listResources();
  assert.ok(resources.some(({ uri }) => uri === 'qlm://demo/security/overview.md'));
  const resource = await client.readResource({ uri: 'qlm://demo/security/overview.md' });
  assert.match(resource.contents[0]?.text ?? '', /Deterministic local protocol fixture/);

  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map(({ name }) => name).sort(), [
    'identify-dependencies', 'explore-project', 'find-implementation-context',
    'explain-architecture', 'review-specification',
  ].sort());
  const prompt = await client.getPrompt({ name: 'explore-project', arguments: { project: 'demo' } });
  assert.ok(prompt.messages.length > 0);

  const traversal = await client.callTool({
    name: 'memory_read', arguments: { project: 'demo', path: '../../../../outside.md' },
  });
  assert.equal(traversal.isError, true);
  assert.doesNotMatch(JSON.stringify(traversal), /This file must never be exposed/);
  await assert.rejects(
    client.callTool({ name: 'memory_write', arguments: { project: 'demo', path: 'x.md', content: 'no' } }),
  );

  assert.deepEqual(readFileSync(documentPath), initialMarkdown);
  assert.deepEqual(readFileSync(databasePath), initialDatabase);
  const snapshotOutput = runCli('snapshot', 'create', 'demo');
  const snapshotId = snapshotOutput.match(/Created snapshot ([0-9a-f-]+)/)?.[1];
  assert.ok(snapshotId, snapshotOutput);
  const projectMetadata = readFileSync(join(projectRoot, 'project.yaml'), 'utf8');
  const projectId = projectMetadata.match(/^id:\s*([0-9a-f-]+)/m)?.[1];
  assert.ok(projectId, projectMetadata);
  const snapshotFile = join(dataRoot, 'snapshots', projectId, snapshotId, 'knowledge', 'security', 'overview.md');
  writeFileSync(snapshotFile, 'tampered snapshot');
  assert.throws(() => runCli('snapshot', 'list', 'demo'), /Unable to verify project snapshots/);
  assert.throws(
    () => runCli('snapshot', 'restore', 'demo', snapshotId, '--yes'),
    /Unable to verify project snapshots/,
  );
  assert.deepEqual(readFileSync(documentPath), initialMarkdown);
  assert.deepEqual(readFileSync(databasePath), initialDatabase);
  runCli('reindex', '--project', 'demo', '--no-embeddings');
  const recoveredRead = await client.callTool({
    name: 'memory_read', arguments: { project: 'demo', path: 'security/overview.md' },
  });
  assert.equal(recoveredRead.isError, undefined);
  assert.match(JSON.stringify(recoveredRead.structuredContent ?? recoveredRead.content), /MCP verification/);
  await client.close();
  client = undefined;
  assert.equal(serverStderr, '', `Unexpected MCP server stderr: ${serverStderr}`);
  console.log('MCP stdio verification passed: initialization, 9 read-only tools, tree/search/read, resources, prompts, traversal denial, and unchanged files.');
} finally {
  if (client) await client.close().catch(() => {});
  else if (transport) await transport.close().catch(() => {});
  rmSync(temporaryRoot, { recursive: true, force: true });
}
