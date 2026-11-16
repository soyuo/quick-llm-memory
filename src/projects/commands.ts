import { join } from 'node:path';
import type { Command } from 'commander';
import { loadSettings } from '../config/settings.js';
import { resolveSettingsPaths } from '../config/paths.js';
import { InputError } from '../errors/qlm-error.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  type ApplicationLogger,
} from '../logging/logger.js';
import { validateInternalLinks } from '../markdown/link-validator.js';
import { initializeProject, listProjects } from './manager.js';
import { validateProjectName } from './schema.js';

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

  cli
    .command('validate')
    .description('Validate internal Markdown links')
    .requiredOption('--project <name>', 'Project to validate')
    .action(async ({ project }: { project: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(project);
        const exists = listProjects(dataRoot).some(({ name }) => name === projectName);
        if (!exists) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }

        const knowledgeRoot = join(
          dataRoot,
          'projects',
          projectName,
          'knowledge',
        );
        const result = validateInternalLinks(knowledgeRoot);
        for (const link of result.brokenLinks) {
          writeOut(
            `Broken link: ${link.sourcePath}:${link.line} -> ${link.target} (${link.reason})\n` +
              (link.context.length > 0 ? `  ${link.context}\n` : ''),
          );
        }

        if (result.brokenLinks.length > 0) {
          throw new InputError(
            `Found ${result.brokenLinks.length} broken internal link(s) in ${result.filesScanned} Markdown file(s).`,
            { suggestedAction: 'Fix the listed targets and run qlm validate again.' },
          );
        }

        writeOut(
          `Validated ${result.filesScanned} Markdown file(s) and ${result.linksChecked} link(s); no broken links found.\n`,
        );
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
