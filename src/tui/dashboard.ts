import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProjectMetadata } from '../projects/schema.js';
import { listProjects } from '../projects/manager.js';
import { resolveLogFilePath } from '../logging/logger.js';
import { buildKnowledgeTree, type CategoryTreeNode, type KnowledgeTree } from '../markdown/tree.js';

const LOG_TAIL_BYTES = 64 * 1024;

export interface DashboardActivity {
  summary: string;
  kind: 'project' | 'error';
}

export interface TuiDashboardSnapshot {
  projects: ProjectMetadata[];
  selectedProject?: ProjectMetadata;
  documentCount: number;
  categoryCount: number;
  projectSummaryAvailable: boolean;
  recentActivities: DashboardActivity[];
  buildSummary: string;
  mcpSummary: string;
  error?: string;
}

export function loadTuiDashboardSnapshot(
  dataRoot: string,
  selectedProjectName?: string,
): TuiDashboardSnapshot {
  let projects: ProjectMetadata[];
  try {
    projects = listProjects(dataRoot);
  } catch {
    return {
      projects: [],
      documentCount: 0,
      categoryCount: 0,
      projectSummaryAvailable: false,
      recentActivities: [],
      buildSummary: 'Build history is not available.',
      mcpSummary: 'MCP status is client-managed; use MCP Manager to check local stdio.',
      error: 'Project information is unavailable.',
    };
  }

  const selectedProject =
    projects.find(({ name }) => name === selectedProjectName)
    ?? [...projects].sort((left, right) => {
      const updatedDifference = Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return updatedDifference || compareText(left.name, right.name);
    })[0];

  let documentCount = 0;
  let categoryCount = 0;
  let projectSummaryAvailable = true;
  if (selectedProject !== undefined) {
    try {
      const tree = buildKnowledgeTree(
        join(dataRoot, 'projects', selectedProject.name, 'knowledge'),
      );
      documentCount = countDocuments(tree);
      categoryCount = countCategories(tree.categories);
    } catch {
      projectSummaryAvailable = false;
    }
  }

  return {
    projects,
    ...(selectedProject === undefined ? {} : { selectedProject }),
    documentCount,
    categoryCount,
    projectSummaryAvailable,
    recentActivities: readRecentActivities(dataRoot, projects),
    buildSummary: 'Build history is not recorded yet.',
    mcpSummary: 'MCP status is client-managed; use MCP Manager to check local stdio.',
  };
}

function countDocuments(tree: KnowledgeTree): number {
  return tree.documents.length + tree.categories.reduce(
    (total, category) => total + countCategoryDocuments(category),
    0,
  );
}

function countCategoryDocuments(category: CategoryTreeNode): number {
  return category.documents.length + category.categories.reduce(
    (total, child) => total + countCategoryDocuments(child),
    0,
  );
}

function countCategories(categories: readonly CategoryTreeNode[]): number {
  return categories.reduce(
    (total, category) => total + 1 + countCategories(category.categories),
    0,
  );
}

function readRecentActivities(
  dataRoot: string,
  projects: readonly ProjectMetadata[],
): DashboardActivity[] {
  const logPath = resolveLogFilePath(dataRoot);
  let descriptor: number;
  try {
    const pathInfo = lstatSync(logPath);
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
      return [];
    }
    descriptor = openSync(logPath, 'r');
  } catch {
    return [];
  }

  let text: string;
  let startsAtBeginning = false;
  try {
    const fileInfo = fstatSync(descriptor);
    const length = Math.min(fileInfo.size, LOG_TAIL_BYTES);
    startsAtBeginning = fileInfo.size <= LOG_TAIL_BYTES;
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, fileInfo.size - length);
    text = buffer.toString('utf8');
  } catch {
    return [];
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A dashboard summary should remain available if the log handle cannot close.
    }
  }

  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const lines = text.split(/\r?\n/u);
  if (!startsAtBeginning) {
    lines.shift();
  }
  return lines
    .flatMap((line): DashboardActivity[] => {
      try {
        const record: unknown = JSON.parse(line);
        if (record === null || typeof record !== 'object') {
          return [];
        }
        const value = record as Record<string, unknown>;
        if (value.event === 'project.created' || value.event === 'project.reindexed') {
          const name = typeof value.projectId === 'string'
            ? projectNames.get(value.projectId)
            : undefined;
          const prefix = value.event === 'project.created' ? 'Project created' : 'Project reindexed';
          if (value.event === 'project.reindexed' && Number.isSafeInteger(value.documentCount)) {
            return [{
              kind: 'project',
              summary: `${prefix}${name === undefined ? '' : `: ${name}`} (${value.documentCount} documents)`,
            }];
          }
          return [{ kind: 'project', summary: `${prefix}${name === undefined ? '' : `: ${name}`}` }];
        }
        if (value.event === 'application.error') {
          const code = typeof value.errorCode === 'string'
            && /^QLM_[A-Z0-9_]{1,60}$/u.test(value.errorCode)
            ? value.errorCode
            : 'Unexpected error';
          return [{ kind: 'error', summary: `Recent error: ${code}` }];
        }
        return [];
      } catch {
        return [];
      }
    })
    .reverse()
    .slice(0, 4);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
