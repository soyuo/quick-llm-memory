import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
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
    mkdirSync(projectDirectory);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new InputError(`Project already exists: ${projectName}.`, {
        suggestedAction: 'Choose a different project name.',
      });
    }

    throw new InternalError('Unable to create the project directory.', {
      cause: error,
      suggestedAction: 'Check that the data directory is writable.',
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

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'EEXIST'
  );
}
