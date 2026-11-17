import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InputError } from '../src/errors/qlm-error.js';
import { commitGeneratedDocumentUpdates, commitGeneratedDocuments } from '../src/knowledge/atomic-commit.js';
import type { GeneratedMarkdownCandidate } from '../src/knowledge/document-generator.js';
import {
  GeneratedDocumentValidationError,
} from '../src/knowledge/generated-document-validator.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import type { SourceSection } from '../src/knowledge/source.js';
import { buildKnowledgeTree } from '../src/markdown/tree.js';
import type { DocumentFrontmatter } from '../src/markdown/schema.js';
import { stringify } from 'yaml';

const temporaryDirectories: string[] = [];

const authenticationSection: SourceSection = {
  id: 'section-auth',
  sourceId: 'source-spec',
  title: 'Authentication',
  content: 'API keys authenticate callers.',
  headingPath: ['Security', 'Authentication'],
  startOffset: 0,
  endOffset: 30,
  tokenCount: 8,
  hash: 'a'.repeat(64),
};
const billingSection: SourceSection = {
  ...authenticationSection,
  id: 'section-billing',
  title: 'Billing',
  content: 'Invoices are sent monthly.',
  headingPath: ['Billing'],
  startOffset: 31,
  endOffset: 57,
  hash: 'b'.repeat(64),
};

const authenticationNode: HierarchyNode = {
  id: 'security-authentication',
  name: 'Authentication',
  type: 'document',
  path: 'security/authentication.md',
  description: 'Authentication behavior.',
  sourceSectionIds: [authenticationSection.id],
  relatedDocumentIds: ['billing'],
  children: [],
};
const billingNode: HierarchyNode = {
  id: 'billing',
  name: 'Billing',
  type: 'document',
  path: 'billing.md',
  description: 'Billing behavior.',
  sourceSectionIds: [billingSection.id],
  relatedDocumentIds: [],
  children: [],
};
const securityCategory: HierarchyNode = {
  id: 'security',
  name: 'Security',
  type: 'category',
  path: 'security',
  description: 'Security topics.',
  sourceSectionIds: [],
  relatedDocumentIds: [],
  children: [authenticationNode],
};
const sections = [authenticationSection, billingSection];
const hierarchy = [securityCategory, billingNode];

const temporaryDirectoriesForCleanup = temporaryDirectories;
afterEach(() => {
  for (const directory of temporaryDirectoriesForCleanup.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('atomic generated document commit', () => {
  it('stages and installs the complete candidate set with deterministic change paths', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const categoryIndexPath = join(knowledgeRoot, 'security', 'index.md');
    const categoryIndex = categoryIndexMarkdown();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    writeFileSync(categoryIndexPath, categoryIndex, 'utf8');
    writeFileSync(
      join(knowledgeRoot, 'security', 'authentication.md'),
      existingDocument('old-auth', 'Old authentication', 2, 'security'),
      'utf8',
    );
    writeFileSync(join(knowledgeRoot, 'obsolete.md'), existingDocument('obsolete', 'Obsolete', 1), 'utf8');

    const result = commitGeneratedDocuments(
      knowledgeRoot,
      [makeCandidate(authenticationNode, authenticationSection, 'security'), makeCandidate(billingNode, billingSection)],
      hierarchy,
      sections,
    );

    expect(result).toEqual({
      created: ['billing.md'],
      updated: ['security/authentication.md'],
      removed: ['obsolete.md'],
    });
    expect(readFileSync(categoryIndexPath, 'utf8')).toBe(categoryIndex);
    expect(readFileSync(join(knowledgeRoot, 'security', 'authentication.md'), 'utf8')).toContain(
      'id: security-authentication',
    );
    expect(existsSync(join(knowledgeRoot, 'obsolete.md'))).toBe(false);
    expect(buildKnowledgeTree(knowledgeRoot).documents.map((document) => document.path)).toEqual([
      'billing.md',
    ]);
    expect(buildKnowledgeTree(knowledgeRoot).categories[0]?.documents.map((document) => document.path)).toEqual([
      'security/authentication.md',
    ]);
    expect(readdirSync(knowledgeRoot).some((name) => name.startsWith('.qlm-'))).toBe(false);
  });

  it('does not replace a new file that appears at a selected target during commit', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const externalContent = existingDocument('external-billing', 'External billing', 1);
    const originalLinkSync = fs.linkSync;
    let appeared = false;
    fs.linkSync = ((stagePath: string, targetPath: string) => {
      if (!appeared && targetPath.toString().endsWith('billing.md')) {
        appeared = true;
        writeFileSync(targetPath.toString(), externalContent, 'utf8');
      }
      originalLinkSync(stagePath, targetPath);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();
    try {
      expect(() => commitGeneratedDocumentUpdates(
        knowledgeRoot,
        [makeCandidate(billingNode, billingSection)],
        hierarchy,
        [billingNode],
        sections,
        new Map([['billing.md', null]]),
      )).toThrow('A Markdown document appeared during the build: billing.md.');
      expect(appeared).toBe(true);
      expect(readFileSync(join(knowledgeRoot, 'billing.md'), 'utf8')).toBe(externalContent);
      expect(readdirSync(knowledgeRoot).some((name) => name.startsWith('.qlm-'))).toBe(false);
    } finally {
      fs.linkSync = originalLinkSync;
      syncBuiltinESMExports();
    }
  });

  it('restores the old document set and removes transaction artifacts after an install failure', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    const originalAuthentication = existingDocument('old-auth', 'Old authentication', 2, 'security');
    const originalObsolete = existingDocument('obsolete', 'Obsolete', 1);
    writeFileSync(join(knowledgeRoot, 'security', 'authentication.md'), originalAuthentication, 'utf8');
    writeFileSync(join(knowledgeRoot, 'obsolete.md'), originalObsolete, 'utf8');
    const originalLinkSync = fs.linkSync;
    let failedInstall = false;

    fs.linkSync = ((oldPath: string, newPath: string) => {
      if (
        !failedInstall &&
        oldPath.toString().endsWith('.stage') &&
        newPath.toString().endsWith(join('security', 'authentication.md'))
      ) {
        failedInstall = true;
        throw new Error('simulated candidate install failure');
      }
      originalLinkSync(oldPath, newPath);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();

    try {
      expect(() =>
        commitGeneratedDocuments(
          knowledgeRoot,
          [makeCandidate(authenticationNode, authenticationSection, 'security'), makeCandidate(billingNode, billingSection)],
          hierarchy,
          sections,
        ),
      ).toThrow('Unable to commit generated Markdown documents.');
      expect(failedInstall).toBe(true);
      expect(readFileSync(join(knowledgeRoot, 'security', 'authentication.md'), 'utf8')).toBe(
        originalAuthentication,
      );
      expect(readFileSync(join(knowledgeRoot, 'obsolete.md'), 'utf8')).toBe(originalObsolete);
      expect(existsSync(join(knowledgeRoot, 'billing.md'))).toBe(false);
      expect(readdirSync(knowledgeRoot).some((name) => name.startsWith('.qlm-'))).toBe(false);
    } finally {
      fs.linkSync = originalLinkSync;
      syncBuiltinESMExports();
    }
  });

  it('removes a newly created knowledge root when the first install fails', () => {
    const projectDirectory = createTemporaryDirectory();
    const knowledgeRoot = join(projectDirectory, 'knowledge');
    const originalLinkSync = fs.linkSync;
    let failedInstall = false;
    const singleDocument = { ...authenticationNode, relatedDocumentIds: [] };
    const singleCategory = { ...securityCategory, children: [singleDocument] };

    fs.linkSync = ((oldPath: string, newPath: string) => {
      if (!failedInstall && oldPath.toString().endsWith('.stage')) {
        failedInstall = true;
        throw new Error('simulated first install failure');
      }
      originalLinkSync(oldPath, newPath);
    }) as typeof fs.linkSync;
    syncBuiltinESMExports();

    try {
      expect(() =>
        commitGeneratedDocuments(
          knowledgeRoot,
          [makeCandidate(singleDocument, authenticationSection, 'security')],
          [singleCategory],
          [authenticationSection],
        ),
      ).toThrow('Unable to commit generated Markdown documents.');
      expect(failedInstall).toBe(true);
      expect(existsSync(knowledgeRoot)).toBe(false);
    } finally {
      fs.linkSync = originalLinkSync;
      syncBuiltinESMExports();
    }
  });

  it('does not create the knowledge root when candidate validation fails', () => {
    const projectDirectory = createTemporaryDirectory();
    const knowledgeRoot = join(projectDirectory, 'knowledge');
    const invalidCandidate = {
      ...makeCandidate(authenticationNode, authenticationSection, 'security'),
      markdown: '---\nid: [invalid\n---\n',
    };

    expect(() =>
      commitGeneratedDocuments(
        knowledgeRoot,
        [invalidCandidate],
        hierarchy,
        sections,
      ),
    ).toThrow(GeneratedDocumentValidationError);
    expect(existsSync(knowledgeRoot)).toBe(false);
  });

  it('preserves category index files and rejects candidate paths that would replace them', () => {
    const knowledgeRoot = createKnowledgeRoot();
    mkdirSync(join(knowledgeRoot, 'security'), { recursive: true });
    const indexPath = join(knowledgeRoot, 'security', 'index.md');
    const indexText = categoryIndexMarkdown();
    writeFileSync(indexPath, indexText, 'utf8');
    const indexNode: HierarchyNode = {
      ...authenticationNode,
      id: 'security-index-document',
      name: 'Security index',
      path: 'security/index.md',
      relatedDocumentIds: [],
    };
    const indexCandidate = makeCandidate(indexNode, authenticationSection, 'security');

    expect(() =>
      commitGeneratedDocuments(
        knowledgeRoot,
        [indexCandidate],
        [{ ...securityCategory, children: [indexNode] }],
        [authenticationSection],
      ),
    ).toThrow(InputError);
    expect(readFileSync(indexPath, 'utf8')).toBe(indexText);
    expect(readdirSync(knowledgeRoot).some((name) => name.startsWith('.qlm-'))).toBe(false);
  });

  it('rejects replacing an existing document set with an empty plan', () => {
    const knowledgeRoot = createKnowledgeRoot();
    const original = existingDocument('existing', 'Existing', 1);
    writeFileSync(join(knowledgeRoot, 'existing.md'), original, 'utf8');

    expect(() => commitGeneratedDocuments(knowledgeRoot, [], [], [])).toThrow(InputError);
    expect(readFileSync(join(knowledgeRoot, 'existing.md'), 'utf8')).toBe(original);
  });

  it('returns an empty result without creating a root for an empty project', () => {
    const projectDirectory = createTemporaryDirectory();
    const knowledgeRoot = join(projectDirectory, 'knowledge');

    expect(commitGeneratedDocuments(knowledgeRoot, [], [], [])).toEqual({
      created: [],
      updated: [],
      removed: [],
    });
    expect(existsSync(knowledgeRoot)).toBe(false);
  });

  it('rejects symlinked output directories without writing outside the knowledge root', (context) => {
    const knowledgeRoot = createKnowledgeRoot();
    const projectDirectory = temporaryDirectories[temporaryDirectories.length - 1];
    const outsideDirectory = join(projectDirectory ?? '', 'outside');
    const linkedDirectory = join(knowledgeRoot, 'linked');
    mkdirSync(outsideDirectory);
    try {
      symlinkSync(outsideDirectory, linkedDirectory, 'junction');
    } catch {
      context.skip();
      return;
    }
    const node: HierarchyNode = {
      ...authenticationNode,
      path: 'linked/authentication.md',
    };
    const category: HierarchyNode = {
      ...securityCategory,
      id: 'linked',
      name: 'Linked',
      path: 'linked',
      children: [node],
    };

    expect(() =>
      commitGeneratedDocuments(
        knowledgeRoot,
        [makeCandidate(node, authenticationSection, 'linked')],
        [category],
        [authenticationSection],
      ),
    ).toThrow(InputError);
    expect(readdirSync(outsideDirectory)).toEqual([]);
  });
});

function makeCandidate(
  node: HierarchyNode,
  section: SourceSection,
  parentCategory?: string,
): GeneratedMarkdownCandidate {
  const frontmatter: DocumentFrontmatter = {
    schema_version: 1,
    id: node.id,
    title: node.name,
    type: 'document',
    depth: node.path.split('/').length,
    status: 'draft',
    ...(parentCategory === undefined ? {} : { category: parentCategory }),
    source_ids: [section.sourceId],
    source_sections: [`${section.sourceId}:${section.id}`],
    related: node.relatedDocumentIds,
    created_at: '2026-11-17T00:00:00.000Z',
    updated_at: '2026-11-17T00:00:00.000Z',
    generation: { provider: 'fake', model: 'test-model', revision: 1 },
  };
  const markdown = [
    '---',
    stringify(frontmatter).trimEnd(),
    '---',
    '',
    `# ${node.name}`,
    '',
    `${node.name} content.`,
    '',
    '## Sources',
    `- \`${section.sourceId}:${section.id}\`: ${section.title}`,
    ...(node.relatedDocumentIds.length === 0
      ? []
      : ['', '## Related', ...node.relatedDocumentIds.map((id) => `- \`${id}\``)]),
    '',
  ].join('\n');
  return { documentId: node.id, path: node.path, frontmatter, markdown };
}

function existingDocument(
  id: string,
  title: string,
  depth: number,
  category?: string,
): string {
  const frontmatter: DocumentFrontmatter = {
    schema_version: 1,
    id,
    title,
    type: 'document',
    depth,
    status: 'draft',
    ...(category === undefined ? {} : { category }),
    source_ids: [],
    source_sections: [],
    related: [],
  };
  return ['---', stringify(frontmatter).trimEnd(), '---', '', `# ${title}`, '', 'Existing content.', ''].join('\n');
}

function categoryIndexMarkdown(): string {
  return [
    '---',
    'id: security',
    'title: Security',
    'depth: 1',
    'type: category-index',
    '---',
    '',
    '# Security',
    '',
  ].join('\n');
}

function createKnowledgeRoot(): string {
  const directory = createTemporaryDirectory();
  const knowledgeRoot = join(directory, 'knowledge');
  mkdirSync(knowledgeRoot, { recursive: true });
  return knowledgeRoot;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qlm-atomic-commit-'));
  temporaryDirectories.push(directory);
  return directory;
}
