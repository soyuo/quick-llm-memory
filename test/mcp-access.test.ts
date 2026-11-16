import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openProjectDatabase,
  resolveProjectDatabasePath,
} from '../src/database/database.js';
import { InputError } from '../src/errors/qlm-error.js';
import {
  assertMcpOperationAllowed,
  readMcpProjectDocument,
  resolveMcpProjectScope,
} from '../src/mcp/access.js';
import { createMarkdownDocument } from '../src/markdown/repository.js';
import { initializeProject } from '../src/projects/manager.js';

const temporaryRoots: string[] = [];

function createProjectFixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'qlm-mcp-access-'));
  temporaryRoots.push(dataRoot);
  const project = initializeProject(dataRoot, 'demo');
  const projectRoot = join(dataRoot, 'projects', 'demo');
  const knowledgeRoot = join(projectRoot, 'knowledge');
  createMarkdownDocument(knowledgeRoot, 'notes/readme.md', {
    metadata: {
      type: 'document',
      schema_version: 1,
      depth: 1,
      title: 'Read me',
      category: 'notes',
      source_ids: [],
      source_sections: [],
      related: [],
      status: 'draft',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      generation: { provider: 'test', model: 'test', revision: 1 },
    },
    body: '\nSafe project-local content.',
  });
  const database = openProjectDatabase(projectRoot, project);
  database.close();

  return { dataRoot, project, projectRoot, knowledgeRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('MCP read-only project access', () => {
  it('resolves one project and returns a relative, validated document', () => {
    const fixture = createProjectFixture();
    const scope = resolveMcpProjectScope(fixture.dataRoot, 'demo');
    const result = readMcpProjectDocument(scope, 'notes/readme.md');

    expect(scope.project.id).toBe(fixture.project.id);
    expect(result).toMatchObject({
      path: 'notes/readme.md',
      metadata: { type: 'document', title: 'Read me' },
      body: '\nSafe project-local content.',
    });
    expect(JSON.stringify(result)).not.toContain(fixture.dataRoot);
  });

  it('rejects unknown projects without exposing local paths', () => {
    const fixture = createProjectFixture();

    expect(() => resolveMcpProjectScope(fixture.dataRoot, 'missing'))
      .toThrow(InputError);
    try {
      resolveMcpProjectScope(fixture.dataRoot, 'missing');
    } catch (error) {
      expect((error as Error).message).not.toContain(fixture.dataRoot);
    }
  });

  it('rejects traversal before returning any document', () => {
    const fixture = createProjectFixture();
    const scope = resolveMcpProjectScope(fixture.dataRoot, 'demo');
    const sourcePath = join(fixture.knowledgeRoot, 'notes', 'readme.md');
    const before = readFileSync(sourcePath, 'utf8');

    expect(() => readMcpProjectDocument(scope, '../outside.md')).toThrow(InputError);
    expect(readFileSync(sourcePath, 'utf8')).toBe(before);
  });

  it('rejects symlinked project and document paths', (context) => {
    const fixture = createProjectFixture();
    const outside = mkdtempSync(join(tmpdir(), 'qlm-mcp-outside-'));
    temporaryRoots.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'outside content');
    const link = join(fixture.knowledgeRoot, 'linked');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      context.skip();
      return;
    }

    const scope = resolveMcpProjectScope(fixture.dataRoot, 'demo');
    expect(() => readMcpProjectDocument(scope, 'linked/secret.md')).toThrow(InputError);

    const projectLink = join(fixture.dataRoot, 'projects', 'alias');
    try {
      symlinkSync(fixture.projectRoot, projectLink, 'junction');
    } catch {
      context.skip();
      return;
    }
    expect(() => resolveMcpProjectScope(fixture.dataRoot, 'alias')).toThrow(InputError);
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('outside content');
  });

  it('rejects a knowledge root that points outside the selected project', (context) => {
    const fixture = createProjectFixture();
    const outside = mkdtempSync(join(tmpdir(), 'qlm-mcp-root-outside-'));
    temporaryRoots.push(outside);
    mkdirSync(join(outside, 'notes'));
    writeFileSync(
      join(outside, 'notes', 'readme.md'),
      'outside content',
    );
    rmSync(fixture.knowledgeRoot, { recursive: true, force: true });
    try {
      symlinkSync(outside, fixture.knowledgeRoot, 'junction');
    } catch {
      context.skip();
      return;
    }

    expect(() => resolveMcpProjectScope(fixture.dataRoot, 'demo')).toThrow(InputError);
    expect(readFileSync(join(outside, 'notes', 'readme.md'), 'utf8'))
      .toBe('outside content');
  });

  it('denies writes and unknown operations before project data changes', () => {
    const fixture = createProjectFixture();
    const sourcePath = join(fixture.knowledgeRoot, 'notes', 'readme.md');
    const databasePath = resolveProjectDatabasePath(fixture.projectRoot);
    const sourceBefore = readFileSync(sourcePath);
    const databaseBefore = readFileSync(databasePath);

    expect(() => assertMcpOperationAllowed('write')).toThrow(InputError);
    expect(() => assertMcpOperationAllowed('unknown-operation')).toThrow(InputError);
    expect(readFileSync(sourcePath).equals(sourceBefore)).toBe(true);
    expect(readFileSync(databasePath).equals(databaseBefore)).toBe(true);
  });
});
