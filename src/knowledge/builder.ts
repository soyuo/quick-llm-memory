import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  readProjectSourceSnapshotReadOnly,
  replaceProjectSourceSnapshot,
  type ProjectSourceSnapshot,
} from '../database/source-snapshot.js';
import { rebuildProjectIndex, type ProjectIndexRebuildResult } from '../database/reindex.js';
import { InputError, QLM_ERROR_CODES, QLMError } from '../errors/qlm-error.js';
import {
  commitGeneratedDocumentUpdates,
  commitGeneratedDocuments,
  type GeneratedDocumentCommitResult,
} from './atomic-commit.js';
import { assertValidGeneratedDocuments } from './generated-document-validator.js';
import { assertValidKnowledgeHierarchy } from './hierarchy-validator.js';
import { MarkdownDocumentParser } from './markdown-parser.js';
import { generateMarkdownDocument, type GeneratedMarkdownCandidate } from './document-generator.js';
import { planKnowledgeHierarchy, type HierarchyNode } from './planner.js';
import { planProjectKnowledgeImpact, type KnowledgeImpactPlan } from './impact-planner.js';
import type { AIProvider } from '../providers/provider.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { loadMarkdownSources, type SourceSection } from './source.js';
import {
  compareProjectSourceSnapshots,
  createProjectSourceSnapshot,
  type SourceChangeSet,
} from './source-changes.js';

export const BUILD_PROGRESS_STAGES = [
  'queued',
  'parsing',
  'comparing',
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
  hierarchySettings?: {
    minDepth: number;
    maxDepth: number;
    autoDepth: boolean;
  };
  documentSettings?: {
    minTokens: number;
    targetTokens: number;
    maxTokens: number;
    preserveCodeBlocks: boolean;
    preserveTables: boolean;
  };
  /** Generate only the outputs selected by the source impact plan. */
  incremental?: boolean;
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
  noOp?: boolean;
  pendingRemovalPaths?: string[];
}

export interface PreparedKnowledgeBuild {
  sources: ReturnType<typeof loadMarkdownSources>;
  sections: SourceSection[];
  hierarchy: HierarchyNode[];
  sourceSnapshot: ProjectSourceSnapshot;
  sourceChanges: SourceChangeSet;
  impactPlan: KnowledgeImpactPlan;
  regenerationPaths: string[];
  pendingRemovalPaths: string[];
  selective: boolean;
  noOp: boolean;
  pendingOnly: boolean;
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

    emit({ stage: 'comparing' });
    ensureNotCancelled();
    const sourceSnapshot = createProjectSourceSnapshot(
      realpathSync(options.sourcePath),
      sources,
      sections,
    );
    const previousSnapshot = readProjectSourceSnapshotReadOnly(
      options.projectRoot,
      options.project,
      sourceSnapshot.sourceRoot,
    );
    const sourceChanges = compareProjectSourceSnapshots(sourceSnapshot, previousSnapshot);
    const impactPlan = planProjectKnowledgeImpact(
      options.projectRoot,
      options.project,
      join(options.projectRoot, 'knowledge'),
      sourceChanges,
    );

    const selective = options.incremental === true && previousSnapshot !== undefined;
    const selectedDocuments = selective
      ? selectIncrementalDocuments(impactPlan, sourceChanges)
      : impactPlan.documents.filter(({ action }) => action === 'regenerate');
    const regenerationPaths = selective
      ? selectedDocuments.map(({ path }) => path)
      : impactPlan.documents
          .filter(({ action }) => action === 'regenerate')
          .map(({ path }) => path);
    const selectedPathKeys = new Set(regenerationPaths.map((path) => path.toLowerCase()));
    const hasDeletedSections = sourceChanges.sections.some(({ status }) => status === 'deleted') ||
      sourceChanges.files.some(({ status }) => status === 'deleted');
    const pendingRemovalPaths = selective && hasDeletedSections
      ? impactPlan.documents
          .filter(({ action, path }) => action === 'regenerate' && !selectedPathKeys.has(path.toLowerCase()))
          .map(({ path }) => path)
      : [];
    const pendingOnly = selective && regenerationPaths.length === 0 && pendingRemovalPaths.length > 0;
    const noOp = selective && regenerationPaths.length === 0 && pendingRemovalPaths.length === 0;

    if (noOp || pendingOnly) {
      emit({
        stage: 'awaiting_approval',
        message: pendingOnly
          ? 'Deleted-source outputs are pending review and will remain unchanged.'
          : 'No generated documents are affected; existing knowledge is unchanged.',
      });
      ensureNotCancelled();
      return {
        sources,
        sections,
        hierarchy: [],
        sourceSnapshot,
        sourceChanges,
        impactPlan,
        regenerationPaths,
        pendingRemovalPaths,
        selective,
        noOp,
        pendingOnly,
      };
    }

    emit({ stage: 'planning' });
    ensureNotCancelled();
    const proposedHierarchy = await planKnowledgeHierarchy(sections, {
      provider: options.provider,
      model: options.model,
      ...(options.hierarchySettings ?? {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    ensureNotCancelled();

    emit({ stage: 'validating' });
    ensureNotCancelled();
    const hierarchy = assertValidKnowledgeHierarchy(proposedHierarchy, sections, {
      ...(options.hierarchySettings === undefined ? {} : {
        minDepth: options.hierarchySettings.minDepth,
        maxDepth: options.hierarchySettings.maxDepth,
      }),
    });
    ensureNotCancelled();

    emit({
      stage: 'awaiting_approval',
      message: 'Validated hierarchy is ready for review.',
    });
    ensureNotCancelled();

    const preparedRegenerationPaths = selective
      ? regenerationPaths
      : flattenPlannedDocuments(hierarchy).map(({ node }) => node.path);
    return {
      sources,
      sections,
      hierarchy,
      sourceSnapshot,
      sourceChanges,
      impactPlan,
      regenerationPaths: preparedRegenerationPaths,
      pendingRemovalPaths,
      selective,
      noOp,
      pendingOnly,
    };
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
    const { sources, sections, hierarchy, sourceSnapshot } = prepared;
    if (prepared.noOp || prepared.pendingOnly) {
      const result: BuildProjectKnowledgeResult = {
        sources: sources.length,
        sections: sections.length,
        categories: 0,
        documents: 0,
        candidates: [],
        commit: { created: [], updated: [], removed: [] },
        index: { categories: 0, documents: 0, relations: 0 },
        ...(prepared.noOp ? { noOp: true } : {}),
        ...(prepared.pendingRemovalPaths.length > 0
          ? { pendingRemovalPaths: prepared.pendingRemovalPaths }
          : {}),
      };
      emit({
        stage: 'completed',
        message: prepared.pendingOnly
          ? 'Deleted-source outputs remain pending review.'
          : 'No generated documents changed.',
      });
      return result;
    }

    const allPlannedDocuments = flattenPlannedDocuments(hierarchy);
    const incremental = prepared.selective;
    const regenerationPathKeys = new Set(prepared.regenerationPaths.map((path) => path.toLowerCase()));
    const plannedDocuments = incremental
      ? allPlannedDocuments.filter(({ node }) => regenerationPathKeys.has(node.path.toLowerCase()))
      : allPlannedDocuments;
    if (incremental && plannedDocuments.length !== prepared.regenerationPaths.length) {
      throw new InputError(
        'The proposed hierarchy does not contain every document in the confirmed impact plan.',
        { suggestedAction: 'Review the proposed structure or run a full build.' },
      );
    }
    const allDocumentNodes = allPlannedDocuments.map(({ node }) => node);
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
          ...(options.documentSettings ?? {}),
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
    const selectedHierarchy = incremental
      ? selectHierarchyByPaths(hierarchy, regenerationPathKeys)
      : hierarchy;
    const validatedCandidates = assertValidGeneratedDocuments(candidates, selectedHierarchy, sections);
    ensureNotCancelled();

    emit({ stage: 'committing' });
    ensureNotCancelled();
    canCancel = false;
    const commit = incremental
      ? commitGeneratedDocumentUpdates(
          options.knowledgeRoot,
          validatedCandidates,
          hierarchy,
          selectedHierarchy,
          sections,
        )
      : commitGeneratedDocuments(options.knowledgeRoot, validatedCandidates, hierarchy, sections);
    emit({ stage: 'indexing' });
    const index = rebuildProjectIndex(options.projectRoot, options.project);
    if (prepared.impactPlan.removedSources.length === 0 && prepared.pendingRemovalPaths.length === 0) {
      replaceProjectSourceSnapshot(
        options.projectRoot,
        options.project,
        sourceSnapshot,
        (options.clock?.() ?? new Date()).toISOString(),
      );
    }

    const result = {
      sources: sources.length,
      sections: sections.length,
      categories: countNodes(hierarchy, 'category'),
      documents: validatedCandidates.length,
      candidates: validatedCandidates,
      commit,
      index,
      ...(prepared.pendingRemovalPaths.length > 0
        ? { pendingRemovalPaths: prepared.pendingRemovalPaths }
        : {}),
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

function selectIncrementalDocuments(
  impactPlan: KnowledgeImpactPlan,
  sourceChanges: SourceChangeSet,
): KnowledgeImpactPlan['documents'] {
  const activeSources = new Set(
    sourceChanges.files
      .filter(({ status }) => status === 'added' || status === 'modified')
      .map(({ sourceId }) => sourceId),
  );
  const activeSections = new Set(
    sourceChanges.sections
      .filter(({ status }) => status === 'added' || status === 'modified')
      .map(({ sectionId }) => sectionId),
  );
  const selectedIds = new Set<string>();
  for (const document of impactPlan.documents) {
    if (document.action !== 'regenerate') continue;
    if (document.reasons.some((reason) =>
      (reason.startsWith('source:') && activeSources.has(reason.slice('source:'.length))) ||
      (reason.startsWith('section:') && activeSections.has(reason.slice('section:'.length)))
    )) {
      selectedIds.add(document.id);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const document of impactPlan.documents) {
      if (document.action !== 'regenerate' || selectedIds.has(document.id)) continue;
      if (document.reasons.some((reason) =>
        reason.startsWith('related:') && selectedIds.has(reason.slice('related:'.length))
      )) {
        selectedIds.add(document.id);
        changed = true;
      }
    }
  }
  return impactPlan.documents.filter(({ id }) => selectedIds.has(id));
}

function selectHierarchyByPaths(
  hierarchy: readonly HierarchyNode[],
  selectedPathKeys: ReadonlySet<string>,
): HierarchyNode[] {
  const visit = (nodes: readonly HierarchyNode[]): HierarchyNode[] => {
    const selected: HierarchyNode[] = [];
    for (const node of nodes) {
      if (node.type === 'document') {
        if (selectedPathKeys.has(node.path.toLowerCase())) selected.push(node);
        continue;
      }
      const children = visit(node.children ?? []);
      if (children.length > 0) selected.push({ ...node, children });
    }
    return selected;
  };
  return visit(hierarchy);
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
