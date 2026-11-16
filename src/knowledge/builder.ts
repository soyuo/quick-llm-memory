import { rebuildProjectIndex, type ProjectIndexRebuildResult } from '../database/reindex.js';
import { InputError } from '../errors/qlm-error.js';
import { commitGeneratedDocuments, type GeneratedDocumentCommitResult } from './atomic-commit.js';
import { assertValidGeneratedDocuments } from './generated-document-validator.js';
import { assertValidKnowledgeHierarchy } from './hierarchy-validator.js';
import { MarkdownDocumentParser } from './markdown-parser.js';
import { generateMarkdownDocument, type GeneratedMarkdownCandidate } from './document-generator.js';
import { planKnowledgeHierarchy, type HierarchyNode } from './planner.js';
import type { AIProvider } from '../providers/provider.js';
import type { ProjectMetadata } from '../projects/schema.js';
import { loadMarkdownSources, type SourceSection } from './source.js';

export interface BuildProjectKnowledgeOptions {
  sourcePath: string;
  projectRoot: string;
  knowledgeRoot: string;
  project: ProjectMetadata;
  provider: AIProvider;
  model: string;
  clock?: () => Date;
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

interface PlannedDocument {
  node: HierarchyNode;
  ancestors: HierarchyNode[];
}

/** Run the validated Phase 3 pipeline, then replace Markdown and rebuild its index. */
export async function buildProjectKnowledge(
  options: BuildProjectKnowledgeOptions,
): Promise<BuildProjectKnowledgeResult> {
  const sources = loadMarkdownSources(options.sourcePath);
  const parser = new MarkdownDocumentParser();
  const parsedDocuments = [];
  for (const source of sources) {
    if (!parser.supports(source.format)) {
      throw new InputError(`Unsupported source format: ${source.format}.`);
    }
    parsedDocuments.push(await parser.parse(source));
  }

  const sections = parsedDocuments.flatMap(({ sections: documentSections }) => documentSections);
  if (sections.length === 0) {
    throw new InputError('The Markdown source contains no sections to build.', {
      suggestedAction: 'Add non-empty Markdown content and run qlm build again.',
    });
  }

  const proposedHierarchy = await planKnowledgeHierarchy(sections, {
    provider: options.provider,
    model: options.model,
  });
  const hierarchy = assertValidKnowledgeHierarchy(proposedHierarchy, sections);
  const plannedDocuments = flattenPlannedDocuments(hierarchy);
  const allDocumentNodes = plannedDocuments.map(({ node }) => node);
  const candidates: GeneratedMarkdownCandidate[] = [];

  for (const planned of plannedDocuments) {
    candidates.push(
      await generateMarkdownDocument({
        provider: options.provider,
        model: options.model,
        node: planned.node,
        sourceSections: sections,
        ancestors: planned.ancestors,
        relatedDocuments: allDocumentNodes,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }),
    );
  }

  const validatedCandidates = assertValidGeneratedDocuments(
    candidates,
    hierarchy,
    sections,
  );
  const commit = commitGeneratedDocuments(
    options.knowledgeRoot,
    validatedCandidates,
    hierarchy,
    sections,
  );
  const index = rebuildProjectIndex(options.projectRoot, options.project);

  return {
    sources: sources.length,
    sections: sections.length,
    categories: countNodes(hierarchy, 'category'),
    documents: validatedCandidates.length,
    candidates: validatedCandidates,
    commit,
    index,
  };
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
