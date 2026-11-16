import { posix } from 'node:path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { InputError } from '../errors/qlm-error.js';
import { parseMarkdownDocument } from '../markdown/parser.js';
import { documentFrontmatterSchema } from '../markdown/schema.js';
import type { GeneratedMarkdownCandidate } from './document-generator.js';
import type { HierarchyNode } from './planner.js';
import type { SourceSection } from './source.js';

export type GeneratedDocumentDiagnosticCode =
  | 'invalid_candidate'
  | 'missing_document'
  | 'unknown_document'
  | 'duplicate_document'
  | 'invalid_path'
  | 'duplicate_path'
  | 'invalid_markdown'
  | 'invalid_frontmatter'
  | 'metadata_mismatch'
  | 'unknown_source_reference'
  | 'missing_source_reference'
  | 'missing_content';

export interface GeneratedDocumentDiagnostic {
  code: GeneratedDocumentDiagnosticCode;
  path: string;
  message: string;
}

export type GeneratedDocumentValidationResult =
  | {
      valid: true;
      candidates: GeneratedMarkdownCandidate[];
      diagnostics: [];
    }
  | {
      valid: false;
      diagnostics: GeneratedDocumentDiagnostic[];
    };

export class GeneratedDocumentValidationError extends InputError {
  readonly diagnostics: GeneratedDocumentDiagnostic[];

  constructor(diagnostics: GeneratedDocumentDiagnostic[]) {
    super('Generated Markdown candidates are invalid.', {
      details: { diagnostics },
      suggestedAction: 'Correct the candidate diagnostics before committing documents.',
    });
    this.diagnostics = diagnostics;
  }
}

interface PlannedDocument {
  node: HierarchyNode;
  parentCategoryPath: string | undefined;
}

interface MarkdownAstNode {
  type?: unknown;
  depth?: unknown;
  value?: unknown;
  children?: unknown;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

const markdownParser = unified().use(remarkParse);
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu;

/** Validate candidates against the plan without reading or writing the filesystem. */
export function validateGeneratedDocuments(
  candidates: readonly GeneratedMarkdownCandidate[],
  hierarchy: readonly HierarchyNode[],
  sections: readonly SourceSection[],
): GeneratedDocumentValidationResult {
  const diagnostics: GeneratedDocumentDiagnostic[] = [];
  const plannedDocuments = flattenPlannedDocuments(hierarchy);
  const plannedById = new Map(plannedDocuments.map((document) => [document.node.id, document]));
  const sectionByReference = new Map<string, SourceSection>();
  const sectionById = new Map<string, SourceSection>();
  for (const section of sections) {
    sectionByReference.set(sourceSectionReference(section), section);
    sectionById.set(section.id, section);
  }

  const candidateById = new Map<string, GeneratedMarkdownCandidate>();
  const candidatePathByKey = new Map<string, string>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    const diagnosticPath = isNonEmptyString(candidate.path)
      ? candidate.path
      : `/candidates/${index}`;

    if (!isNonEmptyString(candidate.documentId) || !isNonEmptyString(candidate.path)) {
      diagnostics.push({
        code: 'invalid_candidate',
        path: diagnosticPath,
        message: 'Candidate documentId and path must be non-empty strings.',
      });
      continue;
    }

    const planned = plannedById.get(candidate.documentId);
    if (planned === undefined) {
      diagnostics.push({
        code: 'unknown_document',
        path: candidate.path,
        message: `Candidate does not match a planned document: ${candidate.documentId}.`,
      });
    }

    const previousCandidate = candidateById.get(candidate.documentId);
    if (previousCandidate !== undefined) {
      diagnostics.push({
        code: 'duplicate_document',
        path: candidate.path,
        message: `Document ID duplicates the candidate at ${previousCandidate.path}.`,
      });
    } else {
      candidateById.set(candidate.documentId, candidate);
    }

    validateOutputPath(candidate.path, diagnosticPath, diagnostics);
    const pathKey = candidate.path.toLowerCase();
    const previousPath = candidatePathByKey.get(pathKey);
    if (previousPath !== undefined) {
      diagnostics.push({
        code: 'duplicate_path',
        path: candidate.path,
        message: `Output path duplicates ${previousPath} (paths are case-insensitive on Windows).`,
      });
    } else {
      candidatePathByKey.set(pathKey, candidate.path);
    }

    if (planned !== undefined && candidate.path !== planned.node.path) {
      diagnostics.push({
        code: 'metadata_mismatch',
        path: candidate.path,
        message: `Candidate path must match the planned path ${planned.node.path}.`,
      });
    }

    validateCandidate(candidate, planned, sectionByReference, sectionById, diagnostics);
  }

  for (const planned of plannedDocuments) {
    if (!candidateById.has(planned.node.id)) {
      diagnostics.push({
        code: 'missing_document',
        path: planned.node.path,
        message: `No generated candidate was supplied for planned document ${planned.node.id}.`,
      });
    }
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics };
  }

  const orderedCandidates = [...candidates].sort((left, right) => comparePaths(left.path, right.path));
  return { valid: true, candidates: orderedCandidates, diagnostics: [] };
}

/** Return validated candidates or throw a typed error containing all diagnostics. */
export function assertValidGeneratedDocuments(
  candidates: readonly GeneratedMarkdownCandidate[],
  hierarchy: readonly HierarchyNode[],
  sections: readonly SourceSection[],
): GeneratedMarkdownCandidate[] {
  const result = validateGeneratedDocuments(candidates, hierarchy, sections);
  if (!result.valid) {
    throw new GeneratedDocumentValidationError(result.diagnostics);
  }
  return result.candidates;
}

function flattenPlannedDocuments(
  hierarchy: readonly HierarchyNode[],
): PlannedDocument[] {
  const documents: PlannedDocument[] = [];
  const stack = hierarchy
    .map((node) => ({ node, parentCategoryPath: undefined as string | undefined }))
    .reverse();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    if (current.node.type === 'document') {
      documents.push(current);
      continue;
    }
    for (let index = (current.node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      const child = current.node.children?.[index];
      if (child !== undefined) {
        stack.push({ node: child, parentCategoryPath: current.node.path });
      }
    }
  }

  return documents;
}

function validateCandidate(
  candidate: GeneratedMarkdownCandidate,
  planned: PlannedDocument | undefined,
  sectionsByReference: ReadonlyMap<string, SourceSection>,
  sectionsById: ReadonlyMap<string, SourceSection>,
  diagnostics: GeneratedDocumentDiagnostic[],
): void {
  const frontmatterResult = documentFrontmatterSchema.safeParse(candidate.frontmatter);
  if (!frontmatterResult.success) {
    diagnostics.push({
      code: 'invalid_frontmatter',
      path: candidate.path,
      message: `Candidate frontmatter is invalid: ${frontmatterResult.error.issues.map((issue) => issue.message).join('; ')}.`,
    });
  }

  if (typeof candidate.markdown !== 'string') {
    diagnostics.push({
      code: 'invalid_markdown',
      path: candidate.path,
      message: 'Candidate Markdown must be a string with YAML frontmatter.',
    });
    return;
  }

  let parsed;
  try {
    parsed = parseMarkdownDocument(candidate.markdown, candidate.path);
  } catch (error) {
    diagnostics.push({
      code: 'invalid_markdown',
      path: candidate.path,
      message: error instanceof Error ? error.message : 'Candidate Markdown could not be parsed.',
    });
    return;
  }

  if (parsed.metadata.type !== 'document') {
    diagnostics.push({
      code: 'invalid_frontmatter',
      path: candidate.path,
      message: 'Generated candidate frontmatter type must be document.',
    });
    return;
  }
  if (frontmatterResult.success && !sameJsonValue(frontmatterResult.data, parsed.metadata)) {
    diagnostics.push({
      code: 'metadata_mismatch',
      path: candidate.path,
      message: 'Candidate frontmatter object does not match the YAML in its Markdown.',
    });
  }
  if (parsed.body.trim().length === 0) {
    diagnostics.push({
      code: 'missing_content',
      path: candidate.path,
      message: 'Candidate Markdown body must not be empty.',
    });
  }

  const expectedMetadata = expectedFrontmatter(planned, sectionsById);
  if (expectedMetadata === undefined) {
    return;
  }
  const actualSourceReferences = parsed.metadata.source_sections ?? [];
  for (const reference of actualSourceReferences) {
    if (!sectionsByReference.has(reference)) {
      diagnostics.push({
        code: 'unknown_source_reference',
        path: candidate.path,
        message: `Frontmatter references an unknown source section: ${reference}.`,
      });
    }
  }
  const knownSourceIds = new Set(
    [...sectionsByReference.values()].map((section) => section.sourceId),
  );
  for (const sourceId of parsed.metadata.source_ids ?? []) {
    if (!knownSourceIds.has(sourceId)) {
      diagnostics.push({
        code: 'unknown_source_reference',
        path: candidate.path,
        message: `Frontmatter references an unknown source document: ${sourceId}.`,
      });
    }
  }
  const expectedSourceReferences = expectedMetadata.source_sections as string[];
  for (const reference of expectedSourceReferences) {
    if (!actualSourceReferences.includes(reference)) {
      diagnostics.push({
        code: 'missing_source_reference',
        path: candidate.path,
        message: `Frontmatter is missing assigned source section ${reference}.`,
      });
    }
  }
  for (const [field, expected] of Object.entries(expectedMetadata)) {
    const actual = parsed.metadata[field as keyof typeof parsed.metadata];
    if (!sameJsonValue(actual, expected)) {
      diagnostics.push({
        code: 'metadata_mismatch',
        path: candidate.path,
        message: `Frontmatter field ${field} does not match the planned document.`,
      });
    }
  }
  if (expectedMetadata.category === undefined && parsed.metadata.category !== undefined) {
    diagnostics.push({
      code: 'metadata_mismatch',
      path: candidate.path,
      message: 'Frontmatter category does not match the planned parent category.',
    });
  }
  if (parsed.metadata.status !== 'draft') {
    diagnostics.push({
      code: 'metadata_mismatch',
      path: candidate.path,
      message: 'Generated candidate status must be draft before commit.',
    });
  }

  let markdownTree: MarkdownAstNode;
  try {
    markdownTree = markdownParser.parse(parsed.body) as unknown as MarkdownAstNode;
  } catch (error) {
    diagnostics.push({
      code: 'invalid_markdown',
      path: candidate.path,
      message: error instanceof Error ? error.message : 'Candidate Markdown body could not be parsed.',
    });
    return;
  }
  const children = Array.isArray(markdownTree.children)
    ? (markdownTree.children as MarkdownAstNode[])
    : [];
  const titleHeading = children[0];
  if (
    titleHeading?.type !== 'heading' ||
    titleHeading.depth !== 1 ||
    headingText(titleHeading) !== parsed.metadata.title
  ) {
    diagnostics.push({
      code: 'missing_content',
      path: candidate.path,
      message: 'Candidate must begin with an H1 matching its frontmatter title.',
    });
  }

  const sourcesHeadingIndex = children.findIndex(
    (node) => node.type === 'heading' && node.depth === 2 && headingText(node) === 'Sources',
  );
  const contentEnd = sourcesHeadingIndex < 0 ? children.length : sourcesHeadingIndex;
  const hasGeneratedContent = children
    .slice(1, contentEnd)
    .some((node) => node.type !== 'heading' && headingText(node).trim().length > 0);
  if (!hasGeneratedContent) {
    diagnostics.push({
      code: 'missing_content',
      path: candidate.path,
      message: 'Candidate must contain document content before its Sources section.',
    });
  }

  const sectionReferences = expectedMetadata.source_sections as string[];
  const sourcesText = markdownSectionText(parsed.body, children, 'Sources');
  if (
    sourcesText === undefined ||
    sectionReferences.some((reference) => !sourcesText.includes(`\`${reference}\``))
  ) {
    diagnostics.push({
      code: 'missing_source_reference',
      path: candidate.path,
      message: 'Candidate Markdown must list every assigned source section under Sources.',
    });
  }

  const relatedReferences = expectedMetadata.related as string[];
  const relatedText = markdownSectionText(parsed.body, children, 'Related');
  if (
    relatedReferences.length > 0 &&
    (relatedText === undefined || relatedReferences.some((id) => !relatedText.includes(`\`${id}\``)))
  ) {
    diagnostics.push({
      code: 'metadata_mismatch',
      path: candidate.path,
      message: 'Candidate Markdown must list every related document under Related.',
    });
  }
}

function markdownSectionText(
  body: string,
  children: readonly MarkdownAstNode[],
  title: string,
): string | undefined {
  const headingIndex = children.findIndex(
    (node) => node.type === 'heading' && node.depth === 2 && headingText(node) === title,
  );
  const heading = children[headingIndex];
  const start = heading?.position?.end?.offset;
  if (headingIndex < 0 || start === undefined) {
    return undefined;
  }
  let end = body.length;
  for (let index = headingIndex + 1; index < children.length; index += 1) {
    const node = children[index];
    const offset = node?.position?.start?.offset;
    if (node?.type === 'heading' && typeof node.depth === 'number' && node.depth <= 2) {
      if (offset !== undefined) {
        end = offset;
      }
      break;
    }
  }
  return body.slice(start, end);
}

function expectedFrontmatter(
  planned: PlannedDocument | undefined,
  sectionsById: ReadonlyMap<string, SourceSection>,
): Record<string, unknown> | undefined {
  if (planned === undefined) {
    return undefined;
  }
  const node = planned.node;
  const selectedSections = node.sourceSectionIds
    .map((id) => sectionsById.get(id))
    .filter((section): section is SourceSection => section !== undefined);
  const sourceIds = [...new Set(selectedSections.map((section) => section.sourceId))];
  const sourceReferences = selectedSections.map(sourceSectionReference);

  return {
    id: node.id,
    title: node.name,
    type: 'document',
    depth: node.path.split('/').length,
    ...(planned.parentCategoryPath === undefined ? {} : { category: planned.parentCategoryPath }),
    source_ids: sourceIds,
    source_sections: sourceReferences,
    related: node.relatedDocumentIds,
  };
}

function validateOutputPath(
  path: string,
  diagnosticPath: string,
  diagnostics: GeneratedDocumentDiagnostic[],
): void {
  const segments = path.split('/');
  const normalized = posix.normalize(path);
  const invalid =
    path.trim() !== path ||
    path.includes('\\') ||
    path.includes(':') ||
    posix.isAbsolute(path) ||
    normalized !== path ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment),
    ) ||
    !/\.(?:md|markdown)$/iu.test(path);
  if (invalid) {
    diagnostics.push({
      code: 'invalid_path',
      path: diagnosticPath,
      message: 'Output path must be a normalized, portable Markdown path relative to the knowledge root.',
    });
  }
}

function sourceSectionReference(section: SourceSection): string {
  return `${section.sourceId}:${section.id}`;
}

function headingText(node: MarkdownAstNode): string {
  if (typeof node.value === 'string') {
    return node.value;
  }
  return Array.isArray(node.children)
    ? (node.children as MarkdownAstNode[]).map(headingText).join('')
    : '';
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (typeof left === 'object' && left !== null && typeof right === 'object' && right !== null) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return sameJsonValue(leftKeys, rightKeys) && leftKeys.every((key) => sameJsonValue(leftRecord[key], rightRecord[key]));
  }
  return left === right;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function comparePaths(left: string, right: string): number {
  const leftLower = left.toLowerCase();
  const rightLower = right.toLowerCase();
  return leftLower < rightLower ? -1 : leftLower > rightLower ? 1 : left < right ? -1 : left > right ? 1 : 0;
}
