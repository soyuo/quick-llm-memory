import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { InputError } from '../errors/qlm-error.js';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
import {
  projectMetadataSchema,
  validateProjectName,
  type ProjectMetadata,
} from '../projects/schema.js';
import type { DocumentFrontmatter } from '../markdown/schema.js';

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
export function assertMcpOperationAllowed(operation: string): void {
  if (operation !== 'read') {
    throw new InputError('MCP operation is not allowed by the read-only policy.');
  }
}

export function resolveMcpProjectScope(
  dataRoot: string,
  projectName: string,
): McpProjectScope {
  assertMcpOperationAllowed('read');
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

  return {
    project,
    projectRoot,
    knowledgeRoot: join(projectRoot, KNOWLEDGE_DIRECTORY),
  };
}

export function readMcpProjectDocument(
  scope: McpProjectScope,
  relativePath: string,
): McpReadableDocument {
  assertMcpOperationAllowed('read');

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
