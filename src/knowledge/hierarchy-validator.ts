import { z } from 'zod';
import { InputError } from '../errors/qlm-error.js';
import { HIERARCHY_PLANNER_SCHEMA, type HierarchyNode } from './planner.js';
import type { SourceSection } from './source.js';

export const DEFAULT_HIERARCHY_MAX_DEPTH = 5;

/** The planner's strict object-root JSON Schema, also used by this validator. */
export const HIERARCHY_VALIDATION_JSON_SCHEMA = HIERARCHY_PLANNER_SCHEMA;

export type HierarchyValidationDiagnosticCode =
  | 'invalid_options'
  | 'invalid_schema'
  | 'circular_hierarchy'
  | 'max_depth_exceeded'
  | 'invalid_path'
  | 'reserved_name'
  | 'duplicate_id'
  | 'duplicate_path'
  | 'invalid_parent'
  | 'duplicate_source_section'
  | 'unknown_source_section'
  | 'missing_source_section'
  | 'unknown_related_document'
  | 'invalid_related_document'
  | 'unnecessary_category';

export interface HierarchyValidationDiagnostic {
  code: HierarchyValidationDiagnosticCode;
  message: string;
  /** JSON Pointer-like location in the hierarchy or source-section list. */
  path: string;
}

export type HierarchyValidationResult =
  | {
      valid: true;
      hierarchy: HierarchyNode[];
      diagnostics: [];
    }
  | {
      valid: false;
      diagnostics: HierarchyValidationDiagnostic[];
    };

export interface HierarchyValidationOptions {
  maxDepth?: number;
}

export class HierarchyValidationError extends InputError {
  readonly diagnostics: HierarchyValidationDiagnostic[];

  constructor(diagnostics: HierarchyValidationDiagnostic[]) {
    super('The planned knowledge hierarchy is invalid.', {
      details: { diagnostics },
      suggestedAction: 'Review the hierarchy validation diagnostics and regenerate the plan.',
    });
    this.diagnostics = diagnostics;
  }
}

const hierarchyNodeShapeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(['category', 'document']),
    path: z.string().min(1),
    description: z.string(),
    sourceSectionIds: z.array(z.string().min(1)),
    relatedDocumentIds: z.array(z.string().min(1)),
    children: z.array(z.unknown()),
  })
  .strict();

interface NodeRecord {
  node: HierarchyNode;
  path: string;
  depth: number;
  parent: HierarchyNode | undefined;
}

/** Validate planner output without modifying it or its source sections. */
export function validateKnowledgeHierarchy(
  input: unknown,
  sections: readonly SourceSection[],
  options: HierarchyValidationOptions = {},
): HierarchyValidationResult {
  const diagnostics: HierarchyValidationDiagnostic[] = [];
  const maxDepth = options.maxDepth ?? DEFAULT_HIERARCHY_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    return {
      valid: false,
      diagnostics: [
        {
          code: 'invalid_options',
          path: '/options/maxDepth',
          message: 'maxDepth must be a positive safe integer.',
        },
      ],
    };
  }

  const rootResult = z.array(z.unknown()).safeParse(input);
  if (!rootResult.success) {
    return {
      valid: false,
      diagnostics: rootResult.error.issues.map((issue) => ({
        code: 'invalid_schema',
        path: toPointer(issue.path),
        message: issue.message,
      })),
    };
  }

  const records: NodeRecord[] = [];
  const stack: Array<{
    value: unknown;
    pointer: string;
    depth: number;
    parent: HierarchyNode | undefined;
  }> = rootResult.data.map((value, index) => ({
    value,
    pointer: `/${index}`,
    depth: 1,
    parent: undefined,
  })).reverse();
  const visited = new WeakSet<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    if (
      typeof current.value === 'object' &&
      current.value !== null
    ) {
      if (visited.has(current.value)) {
        diagnostics.push({
          code: 'circular_hierarchy',
          path: current.pointer,
          message: 'A hierarchy node object cannot appear more than once.',
        });
        continue;
      }
      visited.add(current.value);
    }

    if (current.depth > maxDepth) {
      diagnostics.push({
        code: 'max_depth_exceeded',
        path: current.pointer,
        message: `Hierarchy depth ${current.depth} exceeds the maximum of ${maxDepth}.`,
      });
    }

    const nodeResult = hierarchyNodeShapeSchema.safeParse(current.value);
    if (!nodeResult.success) {
      diagnostics.push(
        ...nodeResult.error.issues.map((issue) => ({
          code: 'invalid_schema' as const,
          path: toPointer([...current.pointer.split('/').filter(Boolean), ...issue.path]),
          message: issue.message,
        })),
      );
      const maybeChildren =
        typeof current.value === 'object' && current.value !== null
          ? (current.value as { children?: unknown }).children
          : undefined;
      if (Array.isArray(maybeChildren)) {
        for (let index = maybeChildren.length - 1; index >= 0; index -= 1) {
          stack.push({
            value: maybeChildren[index],
            pointer: `${current.pointer}/children/${index}`,
            depth: current.depth + 1,
            parent: undefined,
          });
        }
      }
      continue;
    }

    const node = current.value as HierarchyNode;
    records.push({
      node,
      path: current.pointer,
      depth: current.depth,
      parent: current.parent,
    });
    validateNodePath(node, current.depth, current.pointer, diagnostics);

    const children = node.children ?? [];
    if (node.type === 'document' && children.length > 0) {
      diagnostics.push({
        code: 'invalid_parent',
        path: `${current.pointer}/children`,
        message: 'Document nodes cannot contain child nodes.',
      });
    }

    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({
        value: children[index],
        pointer: `${current.pointer}/children/${index}`,
        depth: current.depth + 1,
        parent: node,
      });
    }
  }

  const ids = new Map<string, NodeRecord>();
  const paths = new Map<string, NodeRecord>();
  const documentIds = new Set<string>();
  const knownSourceIds = new Set<string>();
  const sourceIdIndexes = new Map<string, number>();
  for (let index = 0; index < sections.length; index += 1) {
    const id = sections[index]?.id;
    if (id !== undefined) {
      const previousIndex = sourceIdIndexes.get(id);
      if (previousIndex !== undefined) {
        diagnostics.push({
          code: 'duplicate_source_section',
          path: `/sections/${index}/id`,
          message: `Source section ID duplicates /sections/${previousIndex}/id.`,
        });
      } else {
        sourceIdIndexes.set(id, index);
      }
      knownSourceIds.add(id);
    }
  }
  const mappedSourceIds = new Set<string>();

  for (const record of records) {
    const { node, path } = record;
    const previousId = ids.get(node.id);
    if (previousId !== undefined) {
      diagnostics.push({
        code: 'duplicate_id',
        path: `${path}/id`,
        message: `Node ID duplicates ${previousId.path}/id.`,
      });
    } else {
      ids.set(node.id, record);
    }

    const normalizedPath = node.path.toLowerCase();
    const previousPath = paths.get(normalizedPath);
    if (previousPath !== undefined) {
      diagnostics.push({
        code: 'duplicate_path',
        path: `${path}/path`,
        message: `Path duplicates ${previousPath.path}/path (paths are case-insensitive on Windows).`,
      });
    } else {
      paths.set(normalizedPath, record);
    }

    for (const sourceId of node.sourceSectionIds) {
      if (!knownSourceIds.has(sourceId)) {
        diagnostics.push({
          code: 'unknown_source_section',
          path: `${path}/sourceSectionIds`,
          message: `Unknown source section ID: ${sourceId}.`,
        });
      } else if (node.type === 'document') {
        mappedSourceIds.add(sourceId);
      }
    }

    if (node.type === 'document') {
      documentIds.add(node.id);
      if (node.sourceSectionIds.length === 0) {
        diagnostics.push({
          code: 'missing_source_section',
          path: `${path}/sourceSectionIds`,
          message: 'Each document must map at least one source section.',
        });
      }
    } else if (node.relatedDocumentIds.length > 0) {
      diagnostics.push({
        code: 'invalid_related_document',
        path: `${path}/relatedDocumentIds`,
        message: 'Category nodes cannot declare related documents.',
      });
    }

    addDuplicateArrayDiagnostics(node.sourceSectionIds, `${path}/sourceSectionIds`, 'source section', diagnostics);
    addDuplicateArrayDiagnostics(node.relatedDocumentIds, `${path}/relatedDocumentIds`, 'related document', diagnostics);
  }

  for (const record of records) {
    const { node, path, depth, parent } = record;
    if (parent !== undefined) {
      if (parent.type !== 'category') {
        diagnostics.push({
          code: 'invalid_parent',
          path,
          message: 'Only category nodes can contain children.',
        });
      }
      if (!node.path.startsWith(`${parent.path}/`)) {
        diagnostics.push({
          code: 'invalid_parent',
          path: `${path}/path`,
          message: 'A child node path must be nested under its parent category path.',
        });
      }
    }

    if (node.type === 'category') {
      const hasDocumentDescendant = records.some(
        (candidate) =>
          candidate.node.type === 'document' &&
          candidate.node.path.startsWith(`${node.path}/`),
      );
      if (!hasDocumentDescendant) {
        diagnostics.push({
          code: 'unnecessary_category',
          path,
          message: 'A category must contain at least one descendant document.',
        });
      }
    }

    if (depth > maxDepth) {
      continue;
    }
    for (const relatedId of node.relatedDocumentIds) {
      const related = ids.get(relatedId);
      if (related === undefined || !documentIds.has(relatedId)) {
        diagnostics.push({
          code: 'unknown_related_document',
          path: `${path}/relatedDocumentIds`,
          message: `Related document ID does not identify a document: ${relatedId}.`,
        });
      } else if (relatedId === node.id) {
        diagnostics.push({
          code: 'invalid_related_document',
          path: `${path}/relatedDocumentIds`,
          message: 'A document cannot be related to itself.',
        });
      }
    }
  }

  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section === undefined) {
      continue;
    }
    if (!mappedSourceIds.has(section.id)) {
      diagnostics.push({
        code: 'missing_source_section',
        path: `/sections/${index}/id`,
        message: `Source section is not mapped to a document: ${section.id}.`,
      });
    }
  }

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics };
  }
  return { valid: true, hierarchy: input as HierarchyNode[], diagnostics: [] };
}

/** Return validated nodes or throw a typed error containing all diagnostics. */
export function assertValidKnowledgeHierarchy(
  input: unknown,
  sections: readonly SourceSection[],
  options: HierarchyValidationOptions = {},
): HierarchyNode[] {
  const result = validateKnowledgeHierarchy(input, sections, options);
  if (!result.valid) {
    throw new HierarchyValidationError(result.diagnostics);
  }
  return result.hierarchy;
}

function validateNodePath(
  node: HierarchyNode,
  depth: number,
  pointer: string,
  diagnostics: HierarchyValidationDiagnostic[],
): void {
  const value = node.path;
  const segments = value.split('/');
  if (
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes(':') ||
    segments.length !== depth ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        /[<>:"|?*\u0000-\u001f]/u.test(segment) ||
        /[. ]$/u.test(segment),
    )
  ) {
    diagnostics.push({
      code: 'invalid_path',
      path: `${pointer}/path`,
      message: 'Path must be a normalized relative path with forward slashes and no traversal segments.',
    });
  }

  for (const segment of segments) {
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9\u00b9\u00b2\u00b3]|LPT[1-9\u00b9\u00b2\u00b3])(?:\.|$)/iu.test(segment)) {
      diagnostics.push({
        code: 'reserved_name',
        path: `${pointer}/path`,
        message: `Path contains a Windows reserved name: ${segment}.`,
      });
      break;
    }
  }

  if (node.type === 'document' && !/\.(?:md|markdown)$/iu.test(value)) {
    diagnostics.push({
      code: 'invalid_path',
      path: `${pointer}/path`,
      message: 'Document paths must use a Markdown extension (.md or .markdown).',
    });
  }
  if (node.type === 'category' && /\.(?:md|markdown)$/iu.test(value)) {
    diagnostics.push({
      code: 'invalid_path',
      path: `${pointer}/path`,
      message: 'Category paths must name directories, not Markdown files.',
    });
  }
}

function addDuplicateArrayDiagnostics(
  values: readonly string[],
  pointer: string,
  label: string,
  diagnostics: HierarchyValidationDiagnostic[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      diagnostics.push({
        code: label === 'source section' ? 'duplicate_source_section' : 'invalid_related_document',
        path: pointer,
        message: `Duplicate ${label} ID: ${value}.`,
      });
    }
    seen.add(value);
  }
}

function toPointer(parts: readonly PropertyKey[]): string {
  return parts.length === 0 ? '' : `/${parts.map(String).map(escapePointerPart).join('/')}`;
}

function escapePointerPart(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}
