import type { Command } from 'commander';
import { loadSettings } from '../config/settings.js';
import { resolveSettingsPaths } from '../config/paths.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  type ApplicationLogger,
} from '../logging/logger.js';
import { initializeProject, listProjects } from './manager.js';

export interface ProjectCommandRuntime {
  dataRoot: string;
  logger: ApplicationLogger;
}

export interface ProjectCommandOptions {
  runtimeFactory?: () => ProjectCommandRuntime;
  writeOut?: (text: string) => void;
}

export function registerProjectCommands(
  cli: Command,
  options: ProjectCommandOptions = {},
): void {
  const runtimeFactory = options.runtimeFactory ?? createProjectRuntime;
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text));

  cli
    .command('init <name>')
    .description('Create a project')
    .action(async (name: string) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot, logger }) => {
        const project = initializeProject(dataRoot, name);
        logProjectCreated(logger, project.id);
        writeOut(`Created project ${project.name}.\n`);
      });
    });

  cli
    .command('project')
    .description('Manage projects')
    .command('list')
    .description('List initialized projects')
    .action(async () => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projects = listProjects(dataRoot);
        if (projects.length === 0) {
          writeOut('No projects found.\n');
          return;
        }

        writeOut(`Projects:\n${projects.map(({ name }) => `- ${name}`).join('\n')}\n`);
      });
    });
}

function createProjectRuntime(): ProjectCommandRuntime {
  const paths = resolveSettingsPaths();
  const settings = loadSettings({ paths });
  const logger = createApplicationLogger({
    dataRoot: paths.dataRoot,
    level: settings.logging.level,
  });

  return { dataRoot: paths.dataRoot, logger };
}

async function withProjectRuntime(
  runtimeFactory: () => ProjectCommandRuntime,
  action: (runtime: ProjectCommandRuntime) => void | Promise<void>,
): Promise<void> {
  const runtime = runtimeFactory();
  try {
    await action(runtime);
  } catch (error) {
    logApplicationError(runtime.logger, error);
    throw error;
  } finally {
    await runtime.logger.close();
  }
}
