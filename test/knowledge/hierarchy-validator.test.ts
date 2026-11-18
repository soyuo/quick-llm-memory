import { describe, expect, it } from 'vitest';
import {
  assertValidKnowledgeHierarchy,
  HIERARCHY_VALIDATION_JSON_SCHEMA,
  HierarchyValidationError,
  validateKnowledgeHierarchy,
  type HierarchyValidationDiagnostic,
} from '../../src/knowledge/hierarchy-validator.js';
import type { HierarchyNode } from '../../src/knowledge/planner.js';
import type { SourceSection } from '../../src/knowledge/source.js';

const sourceSections: SourceSection[] = [
  {
    id: 'section-auth',
    sourceId: 'source-spec',
    title: 'Authentication',
    content: 'Authentication uses API keys.',
    headingPath: ['Security', 'Authentication'],
    startOffset: 0,
    endOffset: 30,
    tokenCount: 8,
    hash: 'a'.repeat(64),
  },
  {
    id: 'section-sessions',
    sourceId: 'source-spec',
    title: 'Sessions',
    content: 'Sessions expire after inactivity.',
    headingPath: ['Security', 'Sessions'],
    startOffset: 31,
    endOffset: 64,
    tokenCount: 9,
    hash: 'b'.repeat(64),
  },
];

function validHierarchy(): HierarchyNode[] {
  return [
    {
      id: 'security',
      name: 'Security',
      type: 'category',
      path: 'security',
      description: 'Security design.',
      sourceSectionIds: [],
      relatedDocumentIds: [],
      children: [
        {
          id: 'authentication',
          name: 'Authentication',
          type: 'document',
          path: 'security/authentication.md',
          description: 'Authentication and session behavior.',
          sourceSectionIds: ['section-auth', 'section-sessions'],
          relatedDocumentIds: [],
          children: [],
        },
      ],
    },
  ];
}

function diagnosticCodes(result: ReturnType<typeof validateKnowledgeHierarchy>): string[] {
  return result.valid ? [] : result.diagnostics.map(({ code }) => code);
}

function expectDiagnostic(
  diagnostics: HierarchyValidationDiagnostic[],
  code: HierarchyValidationDiagnostic['code'],
  path?: string,
): void {
  const diagnostic = diagnostics.find((item) => item.code === code);
  expect(diagnostic).toBeDefined();
  if (path !== undefined) {
    expect(diagnostic?.path).toBe(path);
  }
}

describe('hierarchy validation', () => {
  it('uses the strict object-root planner schema and accepts valid mapped nodes', () => {
    expect(HIERARCHY_VALIDATION_JSON_SCHEMA).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['hierarchy'],
    });

    const hierarchy = validHierarchy();
    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result).toEqual({ valid: true, hierarchy, diagnostics: [] });
    expect(assertValidKnowledgeHierarchy(hierarchy, sourceSections)).toBe(hierarchy);
  });

  it('returns path-aware diagnostics for malformed schema shapes and unknown fields', () => {
    const malformed = validHierarchy();
    const first = malformed[0];
    if (first === undefined) throw new Error('Fixture is missing a root node.');
    (first as HierarchyNode & { unexpected?: boolean }).unexpected = true;
    first.children = [];

    const result = validateKnowledgeHierarchy(malformed, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expectDiagnostic(result.diagnostics, 'invalid_schema', '/0');
  });

  it('rejects non-array input, missing mappings, and unknown source section IDs', () => {
    expect(diagnosticCodes(validateKnowledgeHierarchy({}, sourceSections))).toContain('invalid_schema');

    const hierarchy = validHierarchy();
    const category = hierarchy[0];
    const document = category?.children?.[0];
    if (document === undefined) throw new Error('Fixture is missing a document.');
    document.sourceSectionIds = ['unknown-section'];
    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expectDiagnostic(result.diagnostics, 'unknown_source_section', '/0/children/0/sourceSectionIds');
    expect(result.diagnostics.filter(({ code }) => code === 'missing_source_section')).toHaveLength(2);
    expectDiagnostic(result.diagnostics, 'missing_source_section', '/sections/0/id');
  });

  it('rejects duplicated source mappings, node IDs, and case-insensitive paths', () => {
    const hierarchy = validHierarchy();
    const category = hierarchy[0];
    const document = category?.children?.[0];
    if (category === undefined || document === undefined) throw new Error('Fixture is incomplete.');
    document.sourceSectionIds = ['section-auth', 'section-auth', 'section-sessions'];
    const duplicate = { ...document, path: 'SECURITY/AUTHENTICATION.MD' };
    category.children = [document, duplicate];

    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expectDiagnostic(result.diagnostics, 'duplicate_id', '/0/children/1/id');
    expectDiagnostic(result.diagnostics, 'duplicate_path', '/0/children/1/path');
    expectDiagnostic(result.diagnostics, 'duplicate_source_section', '/0/children/0/sourceSectionIds');
  });

  it.each([
    ['../outside.md', 'invalid_path'],
    ['/absolute.md', 'invalid_path'],
    ['folder\\outside.md', 'invalid_path'],
    ['C:/outside.md', 'invalid_path'],
    ['security/CON.md', 'reserved_name'],
    ['security/COM\u00b9.md', 'reserved_name'],
    ['security/trailing..md ', 'invalid_path'],
  ])('rejects unsafe path %s', (path, code) => {
    const hierarchy = validHierarchy();
    const document = hierarchy[0]?.children?.[0];
    if (document === undefined) throw new Error('Fixture is missing a document.');
    document.path = path;

    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expectDiagnostic(result.diagnostics, code as HierarchyValidationDiagnostic['code'], '/0/children/0/path');
  });

  it('enforces maximum depth and validates the configured limit', () => {
    const hierarchy = validHierarchy();
    const defaultResult = validateKnowledgeHierarchy(hierarchy, sourceSections, { maxDepth: 1 });
    expect(diagnosticCodes(defaultResult)).toContain('max_depth_exceeded');
    expect(validateKnowledgeHierarchy(hierarchy, sourceSections, { maxDepth: 2 }).valid).toBe(true);
    expect(diagnosticCodes(validateKnowledgeHierarchy(hierarchy, sourceSections, { maxDepth: 0 }))).toContain('invalid_options');
  });

  it('enforces a configured minimum document depth', () => {
    const hierarchy = validHierarchy();
    expect(validateKnowledgeHierarchy(hierarchy, sourceSections, { minDepth: 2, maxDepth: 4 }).valid)
      .toBe(true);
    expect(diagnosticCodes(validateKnowledgeHierarchy(hierarchy, sourceSections, {
      minDepth: 3,
      maxDepth: 4,
    }))).toContain('min_depth_not_met');
    expect(diagnosticCodes(validateKnowledgeHierarchy(hierarchy, sourceSections, {
      minDepth: 4,
      maxDepth: 3,
    }))).toContain('invalid_options');
  });

  it('uses the SPEC default maximum depth of five', () => {
    const document: HierarchyNode = {
      id: 'deep-document',
      name: 'Deep document',
      type: 'document',
      path: 'one/two/three/four/deep.md',
      description: 'A document at the default depth boundary.',
      sourceSectionIds: ['section-auth', 'section-sessions'],
      relatedDocumentIds: [],
      children: [],
    };
    let child = document;
    for (const [id, name, path] of [
      ['four', 'Four', 'one/two/three/four'],
      ['three', 'Three', 'one/two/three'],
      ['two', 'Two', 'one/two'],
      ['one', 'One', 'one'],
    ]) {
      child = {
        id,
        name,
        type: 'category',
        path,
        description: `${name} category.`,
        sourceSectionIds: [],
        relatedDocumentIds: [],
        children: [child],
      };
    }
    expect(validateKnowledgeHierarchy([child], sourceSections).valid).toBe(true);
    const secondLevel = child.children?.[0];
    const thirdLevel = secondLevel?.children?.[0];
    const fourthLevel = thirdLevel?.children?.[0];
    if (fourthLevel === undefined) throw new Error('Fixture is missing its fourth-level category.');
    fourthLevel.children = [
      {
        id: 'five',
        name: 'Five',
        type: 'category',
        path: 'one/two/three/four/five',
        description: 'Five category.',
        sourceSectionIds: [],
        relatedDocumentIds: [],
        children: [
          {
            ...document,
            id: 'too-deep-document',
            path: 'one/two/three/four/five/deep.md',
          },
        ],
      },
    ];
    expect(diagnosticCodes(validateKnowledgeHierarchy([child], sourceSections))).toContain('max_depth_exceeded');
  });

  it('rejects mismatched parent paths, document children, and empty categories', () => {
    const hierarchy = validHierarchy();
    const category = hierarchy[0];
    const document = category?.children?.[0];
    if (category === undefined || document === undefined) throw new Error('Fixture is incomplete.');
    document.path = 'another/authentication.md';
    document.children = [
      {
        ...document,
        id: 'nested',
        name: 'Nested',
        path: 'another/nested.md',
        sourceSectionIds: ['section-auth'],
      },
    ];
    category.children = [document];

    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(
      result.diagnostics.some(
        ({ code, path }) => code === 'invalid_parent' && path === '/0/children/0/path',
      ),
    ).toBe(true);
    expectDiagnostic(result.diagnostics, 'invalid_parent', '/0/children/0/children');
    expectDiagnostic(result.diagnostics, 'unnecessary_category', '/0');
  });

  it('rejects invalid related document references', () => {
    const hierarchy = validHierarchy();
    const document = hierarchy[0]?.children?.[0];
    if (document === undefined) throw new Error('Fixture is missing a document.');
    document.relatedDocumentIds = ['missing', document.id];

    const result = validateKnowledgeHierarchy(hierarchy, sourceSections);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expectDiagnostic(result.diagnostics, 'unknown_related_document');
    expectDiagnostic(result.diagnostics, 'invalid_related_document');
  });

  it('rejects circular object graphs and exposes a typed error helper', () => {
    const hierarchy = validHierarchy();
    const category = hierarchy[0];
    if (category === undefined) throw new Error('Fixture is missing a category.');
    category.children = [category];
    expect(diagnosticCodes(validateKnowledgeHierarchy(hierarchy, sourceSections))).toContain('circular_hierarchy');

    expect(() => assertValidKnowledgeHierarchy([], sourceSections)).toThrow(HierarchyValidationError);
  });
});
