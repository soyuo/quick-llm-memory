import { lstatSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { InputError } from '../errors/qlm-error.js';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
import type { DocumentFrontmatter } from '../markdown/schema.js';
import {
  projectMetadataSchema,
  validateProjectName,
  type ProjectMetadata,
} from '../projects/schema.js';

const PROJECTS_DIRECTORY = 'projects';
const PROJECT_METADATA_FILE = 'project.yaml';
const KNOWLEDGE_DIRECTORY = 'knowledge';

export interface McpProjectScope {
  project: ProjectMetadata;
  projectRoot: string;
  knowledgeRoot: string;
}

export interface McpReadableDocument {
  path: string;
  metadata: DocumentFrontmatter & { type: 'document' };
  body: string;
}

/**
 * Phase 5 MCP policy is read-only and default-deny. Future handlers must
 * request the sole allowed operation explicitly before accessing project data.
 */
export type McpPermission =
  | 'READ'
  | 'SEARCH'
  | 'METADATA'
  | 'PROPOSE_WRITE'
  | 'APPROVED_WRITE'
  | 'ADMIN';

const DEFAULT_MCP_PERMISSIONS: ReadonlySet<McpPermission> = new Set([
  'READ',
  'SEARCH',
  'METADATA',
]);
const configuredMcpPermissions = new AsyncLocalStorage<ReadonlySet<McpPermission>>();

export function runWithMcpPermissions<T>(
  permissions: ReadonlySet<McpPermission>,
  callback: () => T,
): T {
  return configuredMcpPermissions.run(permissions, callback);
}

export function assertMcpOperationAllowed(
  permission: McpPermission,
  configuredPermissions: ReadonlySet<McpPermission> =
    configuredMcpPermissions.getStore() ?? DEFAULT_MCP_PERMISSIONS,
): void {
  if (!configuredPermissions.has(permission) && !configuredPermissions.has('ADMIN')) {
    throw new InputError(`MCP permission ${permission} is not enabled.`);
  }
}

export function resolveMcpProjectScope(
  dataRoot: string,
  projectName: string,
): McpProjectScope {
  assertMcpOperationAllowed('READ');
  const name = validateProjectName(projectName);
  const projectsRoot = resolve(dataRoot, PROJECTS_DIRECTORY);
  const projectRoot = join(projectsRoot, name);
  const metadataPath = join(projectRoot, PROJECT_METADATA_FILE);

  try {
    const projectsInfo = lstatSync(projectsRoot);
    const projectInfo = lstatSync(projectRoot);
    const metadataInfo = lstatSync(metadataPath);
    if (
      projectsInfo.isSymbolicLink()
      || !projectsInfo.isDirectory()
      || projectInfo.isSymbolicLink()
      || !projectInfo.isDirectory()
      || metadataInfo.isSymbolicLink()
      || !metadataInfo.isFile()
    ) {
      throw new Error('MCP project path is not a regular directory.');
    }
  } catch (cause) {
    throw new InputError('Selected MCP project is unavailable.', {
      cause,
      suggestedAction: 'Choose an initialized project in the configured data directory.',
    });
  }

  let project: ProjectMetadata;
  try {
    const raw: unknown = parseYaml(readFileSync(metadataPath, 'utf8'));
    const parsed = projectMetadataSchema.safeParse(raw);
    if (!parsed.success || parsed.data.name !== name) {
      throw new Error('Invalid project metadata.');
    }
    project = parsed.data;
  } catch (cause) {
    throw new InputError('Selected MCP project is unavailable.', { cause });
  }

  const knowledgeRoot = join(projectRoot, KNOWLEDGE_DIRECTORY);
  try {
    const knowledgeInfo = lstatSync(knowledgeRoot);
    if (knowledgeInfo.isSymbolicLink() || !knowledgeInfo.isDirectory()) {
      throw new Error('MCP knowledge root is not a regular directory.');
    }
  } catch (cause) {
    if (!isMissingPathError(cause)) {
      throw new InputError('Selected MCP project is unavailable.', { cause });
    }
  }

  return {
    project,
    projectRoot,
    knowledgeRoot,
  };
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export function readMcpProjectDocument(
  scope: McpProjectScope,
  relativePath: string,
): McpReadableDocument {
  assertMcpOperationAllowed('READ');

  try {
    const document = readStoredMarkdownDocument(scope.knowledgeRoot, relativePath);
    if (document.metadata.type !== 'document') {
      throw new Error('Requested Markdown file is not a document.');
    }

    return {
      path: relativePath,
      metadata: document.metadata,
      body: document.body,
    };
  } catch (cause) {
    throw new InputError('Unable to read the requested document within this project.', {
      cause,
      suggestedAction: 'Use a relative Markdown document path from the selected project.',
    });
  }
}
