import { rebuildProjectIndex, type ProjectIndexRebuildResult } from '../database/reindex.js';
import { InputError, QLM_ERROR_CODES, QLMError } from '../errors/qlm-error.js';
import { commitGeneratedDocuments, type GeneratedDocumentCommitResult } from './atomic-commit.js';
import { assertValidGeneratedDocuments } from './generated-document-validator.js';
import { assertValidKnowledgeHierarchy } from './hierarchy-validator.js';
import { MarkdownDocumentParser } from './markdown-parser.js';
import { generateMarkdownDocument, type GeneratedMarkdownCandidate } from './document-generator.js';
import { planKnowledgeHierarchy, type HierarchyNode } from './planner.js';
import type { AIProvider } from '../providers/provider.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { loadMarkdownSources, type SourceSection } from './source.js';

export const BUILD_PROGRESS_STAGES = [
  'queued',
  'parsing',
  'planning',
  'validating',
  'awaiting_approval',
  'generating',
  'verifying',
  'committing',
  'indexing',
  'completed',
  'failed',
  'cancelled',
] as const;

export type BuildProgressStage = (typeof BUILD_PROGRESS_STAGES)[number];

export interface BuildProgressEvent {
  stage: BuildProgressStage;
  completed?: number;
  total?: number;
  message?: string;
}

export type BuildProgressSink = (event: BuildProgressEvent) => void;

export class BuildCancelledError extends QLMError {
  constructor(cause?: unknown) {
    super(QLM_ERROR_CODES.cancelled, 'The knowledge build was cancelled.', {
      cause,
      suggestedAction: 'Run qlm build again when ready.',
    });
  }
}

export interface BuildProjectKnowledgeOptions {
  sourcePath: string;
  projectRoot: string;
  knowledgeRoot: string;
  project: ProjectMetadata;
  provider: AIProvider;
  model: string;
  clock?: () => Date;
  signal?: AbortSignal;
  onProgress?: BuildProgressSink;
}

export interface BuildProjectKnowledgeResult {
  sources: number;
  sections: number;
  categories: number;
  documents: number;
  candidates: GeneratedMarkdownCandidate[];
  commit: GeneratedDocumentCommitResult;
  index: ProjectIndexRebuildResult;
}

export interface PreparedKnowledgeBuild {
  sources: ReturnType<typeof loadMarkdownSources>;
  sections: SourceSection[];
  hierarchy: HierarchyNode[];
}

interface PlannedDocument {
  node: HierarchyNode;
  ancestors: HierarchyNode[];
}

/** Run the validated Phase 3 pipeline, then replace Markdown and rebuild its index. */
export async function buildProjectKnowledge(
  options: BuildProjectKnowledgeOptions,
): Promise<BuildProjectKnowledgeResult> {
  const prepared = await prepareProjectKnowledgeBuild(options);
  return executePreparedKnowledgeBuild(prepared, options);
}

/** Parse sources and return a validated hierarchy without generating or writing documents. */
export async function prepareProjectKnowledgeBuild(
  options: BuildProjectKnowledgeOptions,
): Promise<PreparedKnowledgeBuild> {
  const emit = (event: BuildProgressEvent): void => {
    try {
      options.onProgress?.(event);
    } catch {
      // Progress observers must not change the outcome of a build.
    }
  };
  const ensureNotCancelled = (): void => {
    if (options.signal?.aborted) {
      throw new BuildCancelledError(options.signal.reason);
    }
  };

  try {
    emit({ stage: 'queued' });
    ensureNotCancelled();
    emit({ stage: 'parsing' });
    ensureNotCancelled();
    const sources = loadMarkdownSources(options.sourcePath);
    const parser = new MarkdownDocumentParser();
    const parsedDocuments = [];
    for (let index = 0; index < sources.length; index += 1) {
      ensureNotCancelled();
      const source = sources[index];
      if (source === undefined) {
        continue;
      }
      if (!parser.supports(source.format)) {
        throw new InputError(`Unsupported source format: ${source.format}.`);
      }
      parsedDocuments.push(await parser.parse(source));
      emit({ stage: 'parsing', completed: index + 1, total: sources.length });
    }

    ensureNotCancelled();
    const sections = parsedDocuments.flatMap(({ sections: documentSections }) => documentSections);
    if (sections.length === 0) {
      throw new InputError('The Markdown source contains no sections to build.', {
        suggestedAction: 'Add non-empty Markdown content and run qlm build again.',
      });
    }

    emit({ stage: 'planning' });
    ensureNotCancelled();
    const proposedHierarchy = await planKnowledgeHierarchy(sections, {
      provider: options.provider,
      model: options.model,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    ensureNotCancelled();

    emit({ stage: 'validating' });
    ensureNotCancelled();
    const hierarchy = assertValidKnowledgeHierarchy(proposedHierarchy, sections);
    ensureNotCancelled();

    emit({
      stage: 'awaiting_approval',
      message: 'Validated hierarchy is ready for review.',
    });
    ensureNotCancelled();

    return { sources, sections, hierarchy };
  } catch (error) {
    if (options.signal?.aborted) {
      emit({ stage: 'cancelled' });
      throw new BuildCancelledError(options.signal.reason ?? error);
    }
    emit({ stage: 'failed' });
    throw error;
  }
}

/** Generate and commit only after the caller has accepted the prepared hierarchy. */
export async function executePreparedKnowledgeBuild(
  prepared: PreparedKnowledgeBuild,
  options: BuildProjectKnowledgeOptions,
): Promise<BuildProjectKnowledgeResult> {
  const emit = (event: BuildProgressEvent): void => {
    try {
      options.onProgress?.(event);
    } catch {
      // Progress observers must not change the outcome of a build.
    }
  };
  let canCancel = true;
  const ensureNotCancelled = (): void => {
    if (options.signal?.aborted) {
      throw new BuildCancelledError(options.signal.reason);
    }
  };

  try {
    ensureNotCancelled();
    const { sources, sections, hierarchy } = prepared;
    const plannedDocuments = flattenPlannedDocuments(hierarchy);
    const allDocumentNodes = plannedDocuments.map(({ node }) => node);
    const candidates: GeneratedMarkdownCandidate[] = [];
    emit({ stage: 'generating', completed: 0, total: plannedDocuments.length });

    for (let index = 0; index < plannedDocuments.length; index += 1) {
      ensureNotCancelled();
      const planned = plannedDocuments[index];
      if (planned === undefined) {
        continue;
      }
      candidates.push(
        await generateMarkdownDocument({
          provider: options.provider,
          model: options.model,
          node: planned.node,
          sourceSections: sections,
          ancestors: planned.ancestors,
          relatedDocuments: allDocumentNodes,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }),
      );
      emit({
        stage: 'generating',
        completed: index + 1,
        total: plannedDocuments.length,
      });
    }

    ensureNotCancelled();
    emit({ stage: 'verifying' });
    ensureNotCancelled();
    const validatedCandidates = assertValidGeneratedDocuments(
      candidates,
      hierarchy,
      sections,
    );
    ensureNotCancelled();

    emit({ stage: 'committing' });
    ensureNotCancelled();
    canCancel = false;
    const commit = commitGeneratedDocuments(
      options.knowledgeRoot,
      validatedCandidates,
      hierarchy,
      sections,
    );
    emit({ stage: 'indexing' });
    const index = rebuildProjectIndex(options.projectRoot, options.project);

    const result = {
      sources: sources.length,
      sections: sections.length,
      categories: countNodes(hierarchy, 'category'),
      documents: validatedCandidates.length,
      candidates: validatedCandidates,
      commit,
      index,
    };
    emit({ stage: 'completed' });
    return result;
  } catch (error) {
    if (canCancel && options.signal?.aborted) {
      emit({ stage: 'cancelled' });
      throw new BuildCancelledError(options.signal.reason ?? error);
    }
    emit({ stage: 'failed' });
    throw error;
  }
}

function flattenPlannedDocuments(
  hierarchy: readonly HierarchyNode[],
): PlannedDocument[] {
  const result: PlannedDocument[] = [];
  const visit = (nodes: readonly HierarchyNode[], ancestors: HierarchyNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'category') {
        visit(node.children ?? [], [...ancestors, node]);
      } else {
        result.push({ node, ancestors });
      }
    }
  };

  visit(hierarchy, []);
  return result;
}

function countNodes(
  hierarchy: readonly HierarchyNode[],
  type: HierarchyNode['type'],
): number {
  let count = 0;
  const stack = [...hierarchy];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    if (node.type === type) {
      count += 1;
    }
    stack.push(...(node.children ?? []));
  }
  return count;
}
