import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigurationError } from '../config/error.js';
import { createProjectSnapshot } from './snapshots.js';
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

  let metadataFileDescriptor: number | undefined;
  try {
    metadataFileDescriptor = openSync(metadataPath, 'wx');
    writeFileSync(metadataFileDescriptor, stringifyYaml(metadata), 'utf8');
    closeSync(metadataFileDescriptor);
    metadataFileDescriptor = undefined;
  } catch (error) {
    if (metadataFileDescriptor !== undefined) {
      try {
        closeSync(metadataFileDescriptor);
      } catch {
        // Preserve the original write error.
      }

      try {
        unlinkSync(metadataPath);
      } catch {
        // Cleanup is best-effort; preserve the original write error.
      }
    }

    try {
      rmdirSync(projectDirectory);
    } catch {
      // Keep any concurrent files; remove only an empty project directory.
    }

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

export function renameProject(
  dataRoot: string,
  currentName: string,
  nextName: string,
): ProjectMetadata {
  const sourceName = validateProjectName(currentName);
  const project = requireProject(dataRoot, sourceName);
  const targetName = validateProjectName(nextName);
  if (sourceName === targetName) {
    return project;
  }

  const projectsDirectory = join(dataRoot, PROJECTS_DIRECTORY);
  const sourceDirectory = join(projectsDirectory, sourceName);
  const targetDirectory = join(projectsDirectory, targetName);
  if (pathExists(targetDirectory)) {
    throw new InputError(`Project already exists: ${targetName}.`, {
      suggestedAction: 'Choose a different project name.',
    });
  }

  createProjectSnapshot(dataRoot, project.id, project.name, {
    operation: 'project-rename',
    reason: `rename:${sourceName}->${targetName}`,
  });

  try {
    renameSync(sourceDirectory, targetDirectory);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new InputError(`Project already exists: ${targetName}.`, {
        suggestedAction: 'Choose a different project name.',
      });
    }
    throw new InternalError('Unable to rename the project directory.', {
      cause: error,
      suggestedAction: 'Check that the projects directory is writable.',
    });
  }

  const renamedProject = projectMetadataSchema.parse({
    ...project,
    name: targetName,
    updated_at: new Date(Math.max(Date.now(), Date.parse(project.updated_at) + 1)).toISOString(),
  });
  try {
    writeProjectMetadata(targetDirectory, renamedProject);
  } catch (error) {
    try {
      renameSync(targetDirectory, sourceDirectory);
    } catch (rollbackError) {
      throw new InternalError('Unable to finish or roll back the project rename.', {
        cause: new AggregateError([error, rollbackError]),
        suggestedAction: 'Inspect the projects directory and restore the project folder name.',
      });
    }
    throw error;
  }
  return renamedProject;
}

export function setProjectArchived(
  dataRoot: string,
  name: string,
  archived: boolean,
): ProjectMetadata {
  const project = requireProject(dataRoot, name);
  if ((project.archived_at !== undefined) === archived) {
    return project;
  }
  const updated = projectMetadataSchema.parse({
    ...project,
    ...(archived ? { archived_at: new Date().toISOString() } : {}),
    updated_at: new Date().toISOString(),
  });
  if (!archived) {
    delete (updated as { archived_at?: string }).archived_at;
  }
  writeProjectMetadata(join(dataRoot, PROJECTS_DIRECTORY, project.name), updated);
  return updated;
}

export function deleteProject(
  dataRoot: string,
  name: string,
  confirmation: string,
): void {
  const projectName = validateProjectName(name);
  if (confirmation !== projectName) {
    throw new InputError('Project deletion was not confirmed.', {
      suggestedAction: `Type ${projectName} exactly to confirm deletion.`,
    });
  }
  const project = requireProject(dataRoot, projectName);
  createProjectSnapshot(dataRoot, project.id, project.name, {
    operation: 'project-delete',
    reason: 'confirmed-project-deletion',
  });
  const projectDirectory = join(dataRoot, PROJECTS_DIRECTORY, projectName);
  try {
    rmSync(projectDirectory, { recursive: true });
  } catch (error) {
    throw new InternalError('Unable to delete the project.', {
      cause: error,
      suggestedAction: 'Check that the project data is not in use and the data directory is writable.',
    });
  }
}

function requireProject(dataRoot: string, name: string): ProjectMetadata {
  const projectName = validateProjectName(name);
  const project = listProjects(dataRoot).find(({ name: listedName }) => listedName === projectName);
  if (project === undefined) {
    throw new InputError(`Project not found: ${projectName}.`, {
      suggestedAction: 'Refresh the project list and choose an existing project.',
    });
  }

  const projectDirectory = join(dataRoot, PROJECTS_DIRECTORY, projectName);
  try {
    const info = lstatSync(projectDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new InputError(`Project is not a regular directory: ${projectName}.`);
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new InputError(`Project not found: ${projectName}.`);
    }
    throw error;
  }
  return project;
}

function writeProjectMetadata(
  projectDirectory: string,
  metadata: ProjectMetadata,
): void {
  const metadataPath = join(projectDirectory, PROJECT_METADATA_FILE);
  const temporaryPath = join(projectDirectory, `.project-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx');
    writeFileSync(descriptor, stringifyYaml(metadata), 'utf8');
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, metadataPath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the metadata write error.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Temporary metadata cleanup is best-effort.
    }
    throw new InternalError('Unable to update project metadata.', {
      cause: error,
      suggestedAction: 'Check that the project directory is writable.',
    });
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw new InternalError('Unable to inspect the target project path.', {
      cause: error,
      suggestedAction: 'Check that the projects directory is readable.',
    });
  }
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
