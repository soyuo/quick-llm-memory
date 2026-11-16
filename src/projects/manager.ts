import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigurationError } from '../config/error.js';
import { InputError, InternalError } from '../errors/qlm-error.js';
import {
  projectMetadataSchema,
  validateProjectName,
  type ProjectMetadata,
} from './schema.js';

const PROJECTS_DIRECTORY = 'projects';
const PROJECT_METADATA_FILE = 'project.yaml';

export function initializeProject(
  dataRoot: string,
  name: string,
): ProjectMetadata {
  const projectName = validateProjectName(name);
  const projectsDirectory = join(dataRoot, PROJECTS_DIRECTORY);
  const projectDirectory = join(projectsDirectory, projectName);
  const metadataPath = join(projectDirectory, PROJECT_METADATA_FILE);

  try {
    mkdirSync(projectsDirectory, { recursive: true });
  } catch (error) {
    throw new InternalError('Unable to create the projects directory.', {
      cause: error,
      suggestedAction: 'Check that the data directory is writable.',
    });
  }

  try {
    mkdirSync(projectDirectory);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new InputError(`Project already exists: ${projectName}.`, {
        suggestedAction: 'Choose a different project name.',
      });
    }

    throw new InternalError('Unable to create the project directory.', {
      cause: error,
      suggestedAction: 'Check that the projects directory is writable.',
    });
  }

  const timestamp = new Date().toISOString();
  const metadata = projectMetadataSchema.parse({
    schema_version: 1,
    id: randomUUID(),
    name: projectName,
    created_at: timestamp,
    updated_at: timestamp,
  });

  try {
    writeFileSync(metadataPath, stringifyYaml(metadata), { flag: 'wx' });
  } catch (error) {
    throw new InternalError('Unable to write project metadata.', {
      cause: error,
      suggestedAction: 'Check that the project directory is writable.',
    });
  }

  return metadata;
}

export function listProjects(dataRoot: string): ProjectMetadata[] {
  const projectsDirectory = join(dataRoot, PROJECTS_DIRECTORY);
  let entries: Dirent[];

  try {
    entries = readdirSync(projectsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }

    throw new InternalError('Unable to read the projects directory.', {
      cause: error,
      suggestedAction: 'Check that the data directory is readable.',
    });
  }

  const projects: ProjectMetadata[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const metadataPath = join(projectsDirectory, entry.name, PROJECT_METADATA_FILE);
    let contents: string;
    try {
      contents = readFileSync(metadataPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) {
        continue;
      }

      throw new ConfigurationError(
        `Unable to read project metadata: ${metadataPath}`,
        {
          filePath: metadataPath,
          cause: error,
          suggestedAction: 'Check that the project metadata file is readable.',
        },
      );
    }

    let rawMetadata: unknown;
    try {
      rawMetadata = parseYaml(contents);
    } catch (error) {
      throw new ConfigurationError(
        `Unable to parse project metadata: ${metadataPath}`,
        {
          filePath: metadataPath,
          cause: error,
          suggestedAction: 'Correct the YAML syntax in the project metadata file.',
        },
      );
    }

    const result = projectMetadataSchema.safeParse(rawMetadata);
    if (!result.success) {
      throw new ConfigurationError(`Invalid project metadata: ${metadataPath}`, {
        filePath: metadataPath,
        cause: result.error,
        suggestedAction: 'Restore valid project metadata before listing projects.',
      });
    }

    if (result.data.name !== entry.name) {
      throw new ConfigurationError(
        `Project metadata name does not match its directory: ${metadataPath}`,
        {
          filePath: metadataPath,
          suggestedAction: 'Rename the directory or correct the project metadata name.',
        },
      );
    }

    projects.push(result.data);
  }

  return projects.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
