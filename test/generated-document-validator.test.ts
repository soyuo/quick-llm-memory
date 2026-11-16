import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  assertValidGeneratedDocuments,
  GeneratedDocumentValidationError,
  validateGeneratedDocuments,
} from '../src/knowledge/generated-document-validator.js';
import type { GeneratedMarkdownCandidate } from '../src/knowledge/document-generator.js';
import type { HierarchyNode } from '../src/knowledge/planner.js';
import type { SourceSection } from '../src/knowledge/source.js';
import type { DocumentFrontmatter } from '../src/markdown/schema.js';

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
const hierarchy = [securityCategory, billingNode];
const sections = [authenticationSection, billingSection];

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

const authenticationCandidate = makeCandidate(
  authenticationNode,
  authenticationSection,
  'security',
);
const billingCandidate = makeCandidate(billingNode, billingSection);

describe('generated Markdown validation', () => {
  it('validates candidates against plan and returns stable path order', () => {
    const result = validateGeneratedDocuments(
      [authenticationCandidate, billingCandidate],
      hierarchy,
      sections,
    );

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.candidates.map((candidate) => candidate.path)).toEqual([
        'billing.md',
        'security/authentication.md',
      ]);
    }
  });

  it('reports missing and unknown planned documents with their paths', () => {
    const result = validateGeneratedDocuments(
      [{ ...billingCandidate, documentId: 'unplanned', frontmatter: billingCandidate.frontmatter }],
      hierarchy,
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unknown_document', path: 'billing.md' }),
          expect.objectContaining({
            code: 'missing_document',
            path: 'security/authentication.md',
          }),
        ]),
      );
    }
  });

  it('rejects duplicate document IDs and output paths', () => {
    const duplicatePath = { ...billingCandidate, path: authenticationCandidate.path };
    const result = validateGeneratedDocuments(
      [authenticationCandidate, duplicatePath],
      hierarchy,
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('duplicate_path');
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('metadata_mismatch');
    }
    const duplicateId = validateGeneratedDocuments(
      [authenticationCandidate, { ...authenticationCandidate }],
      [securityCategory],
      sections,
    );
    expect(duplicateId.valid).toBe(false);
    if (!duplicateId.valid) {
      expect(duplicateId.diagnostics.map((diagnostic) => diagnostic.code)).toContain('duplicate_document');
    }
  });

  it.each([
    '../outside.md',
    'CON.md',
    'security\\authentication.md',
    'C:/outside.md',
  ])('rejects unsafe output path %s', (path) => {
    const result = validateGeneratedDocuments(
      [{ ...authenticationCandidate, path }],
      [securityCategory],
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'invalid_path', path })]),
      );
    }
  });

  it('rejects malformed frontmatter and metadata that differs from the plan', () => {
    const malformed = {
      ...authenticationCandidate,
      markdown: authenticationCandidate.markdown.replace('title: Authentication', 'title: [broken'),
    };
    const mismatched = {
      ...authenticationCandidate,
      markdown: authenticationCandidate.markdown.replace(
        'id: security-authentication',
        'id: wrong-document',
      ),
    };
    const result = validateGeneratedDocuments(
      [malformed, mismatched],
      [securityCategory],
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('invalid_markdown');
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('metadata_mismatch');
    }
  });

  it('rejects unknown and missing source provenance in metadata and Markdown', () => {
    const unknownReference = 'foreign-source:foreign-section';
    const candidate = {
      ...authenticationCandidate,
      frontmatter: {
        ...authenticationCandidate.frontmatter,
        source_ids: ['foreign-source'],
        source_sections: [unknownReference],
      },
      markdown: authenticationCandidate.markdown
        .replace('source_ids:\n  - source-spec', 'source_ids:\n  - foreign-source')
        .replace('source-spec:section-auth', unknownReference),
    };
    const missingListing = {
      ...authenticationCandidate,
      markdown: authenticationCandidate.markdown.replace(
        '- `source-spec:section-auth`: Authentication',
        '- missing provenance',
      ),
    };
    const result = validateGeneratedDocuments(
      [candidate, missingListing],
      [securityCategory],
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('unknown_source_reference');
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing_source_reference');
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('metadata_mismatch');
    }
  });

  it('rejects missing document body or title heading', () => {
    const noBody = {
      ...authenticationCandidate,
      markdown: authenticationCandidate.markdown.replace(
        '# Authentication\n\nAuthentication content.',
        '## Not a title',
      ),
    };
    const result = validateGeneratedDocuments([noBody], [securityCategory], sections);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('missing_content');
    }
  });

  it('rejects a candidate containing only its title and source list', () => {
    const structuralOnly = {
      ...authenticationCandidate,
      markdown: authenticationCandidate.markdown.replace(
        '\n\nAuthentication content.\n\n## Sources',
        '\n\n## Sources',
      ),
    };
    const result = validateGeneratedDocuments(
      [structuralOnly],
      [securityCategory],
      sections,
    );

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'missing_content',
            path: authenticationNode.path,
          }),
        ]),
      );
    }
  });

  it('throws a typed error from the assertion helper', () => {
    expect(() => assertValidGeneratedDocuments([], [securityCategory], sections)).toThrow(
      GeneratedDocumentValidationError,
    );
  });

  it('does not alter files while validating candidates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qlm-generated-validation-'));
    try {
      const filePath = join(directory, 'source.md');
      const original = '# Source\n\nOriginal text.\n';
      writeFileSync(filePath, original, 'utf8');

      validateGeneratedDocuments([authenticationCandidate], [securityCategory], sections);

      expect(readFileSync(filePath, 'utf8')).toBe(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
