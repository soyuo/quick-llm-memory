import { join } from 'node:path';
import type { Command } from 'commander';
import { ConfigurationError } from '../config/error.js';
import { loadSettings } from '../config/settings.js';
import { resolveSettingsPaths } from '../config/paths.js';
import { InputError } from '../errors/qlm-error.js';
import type { Settings } from '../config/schema.js';
import { rebuildProjectIndex } from '../database/reindex.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  logProjectReindexed,
  type ApplicationLogger,
} from '../logging/logger.js';
import { validateInternalLinks } from '../markdown/link-validator.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible-provider.js';
import type { AIProvider } from '../providers/provider.js';
import { searchMarkdownDocuments } from '../markdown/search.js';
import {
  searchProjectDocuments,
  type RetrievalMode,
} from '../retrieval/search.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from '../markdown/tree.js';
import { initializeProject, listProjects } from './manager.js';
import { validateProjectName } from './schema.js';
import {
  buildProjectKnowledge,
  type BuildProjectKnowledgeResult,
} from '../knowledge/builder.js';

export interface ProjectCommandRuntime {
  dataRoot: string;
  logger: ApplicationLogger;
  settings?: Settings;
}

export interface ProjectCommandOptions {
  runtimeFactory?: () => ProjectCommandRuntime;
  providerFactory?: (settings: Settings) => AIProvider;
  writeOut?: (text: string) => void;
}

export function registerProjectCommands(
  cli: Command,
  options: ProjectCommandOptions = {},
): void {
  const runtimeFactory = options.runtimeFactory ?? createProjectRuntime;
  const providerFactory = options.providerFactory ?? createConfiguredBuildProvider;
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text));

  cli
    .command('build <source>')
    .description('Build project knowledge from Markdown source')
    .requiredOption('--project <name>', 'Project to build')
    .action(async (sourcePath: string, { project }: { project: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot, settings: runtimeSettings }) => {
        const projectName = validateProjectName(project);
        const projectMetadata = listProjects(dataRoot).find(
          ({ name }) => name === projectName,
        );
        if (projectMetadata === undefined) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }

        const settings = runtimeSettings ?? loadSettings();
        const model = settings.ai?.model;
        if (model === undefined) {
          throw new ConfigurationError('No AI model is configured for knowledge builds.', {
            suggestedAction: 'Set ai.model in config.yaml before running qlm build.',
          });
        }

        const provider = providerFactory(settings);
        const projectRoot = join(dataRoot, 'projects', projectName);
        const controller = new AbortController();
        const abortBuild = (): void => controller.abort();
        process.once('SIGINT', abortBuild);
        let result: BuildProjectKnowledgeResult;
        try {
          result = await buildProjectKnowledge({
            sourcePath,
            projectRoot,
            knowledgeRoot: join(projectRoot, 'knowledge'),
            project: projectMetadata,
            provider,
            model,
            signal: controller.signal,
            onProgress: (event) => {
              const counts =
                event.completed === undefined || event.total === undefined
                  ? ''
                  : ` (${event.completed}/${event.total})`;
              const message = event.message === undefined ? '' : `: ${event.message}`;
              writeOut(`Progress: ${event.stage}${counts}${message}\n`);
            },
          });
        } finally {
          process.removeListener('SIGINT', abortBuild);
        }
        writeOut(
          `Built project ${projectName}: ${result.sources} source(s), ${result.sections} section(s), ` +
            `${result.categories} categor${result.categories === 1 ? 'y' : 'ies'}, ` +
            `${result.documents} document(s); index has ${result.index.documents} document(s).\n`,
        );
        for (const path of result.commit.created) {
          writeOut(`Created: ${path}\n`);
        }
        for (const path of result.commit.updated) {
          writeOut(`Updated: ${path}\n`);
        }
        for (const path of result.commit.removed) {
          writeOut(`Removed: ${path}\n`);
        }
      });
    });

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

  cli
    .command('reindex')
    .description('Rebuild the project SQLite index from Markdown')
    .requiredOption('--project <name>', 'Project to reindex')
    .action(async ({ project }: { project: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot, logger }) => {
        const projectName = validateProjectName(project);
        const projectMetadata = listProjects(dataRoot).find(
          ({ name }) => name === projectName,
        );
        if (projectMetadata === undefined) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }

        const projectRoot = join(dataRoot, 'projects', projectName);
        const result = rebuildProjectIndex(projectRoot, projectMetadata);
        logProjectReindexed(logger, projectMetadata.id, result);
        writeOut(
          `Reindexed project ${projectName}: ${result.documents} document(s), ` +
            `${result.categories} category row(s), ${result.relations} relation(s).\n`,
        );
      });
    });

  cli
    .command('tree')
    .description('Browse a project knowledge tree')
    .requiredOption('--project <name>', 'Project to browse')
    .option('--depth <number>', 'Maximum depth to display (default: 5)')
    .action(async ({ project, depth }: { project: string; depth?: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(project);
        const exists = listProjects(dataRoot).some(({ name }) => name === projectName);
        if (!exists) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }

        const maximumDepth = parseTreeDepth(depth);
        const knowledgeRoot = join(
          dataRoot,
          'projects',
          projectName,
          'knowledge',
        );
        const tree = buildKnowledgeTree(knowledgeRoot);
        const entries = renderKnowledgeTree(tree, maximumDepth);
        writeOut(`Knowledge tree for ${projectName}:\n`);
        writeOut(
          entries.length === 0
            ? hasKnowledgeEntries(tree)
              ? `No categories or documents at depth ${maximumDepth}.\n`
              : 'No knowledge documents or categories found.\n'
            : `${entries.join('\n')}\n`,
        );
      });
    });

  cli
    .command('search <query>')
    .description('Search project Markdown documents')
    .requiredOption('--project <name>', 'Project to search')
    .option('--mode <mode>', 'Retrieval mode: path, hierarchical, or fulltext')
    .option('--max-depth <depth>', 'Maximum hierarchy depth')
    .option('--max-results <count>', 'Maximum number of results')
    .action(async (
      query: string,
      options: {
        project: string;
        mode?: string;
        maxDepth?: string;
        maxResults?: string;
      },
    ) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(options.project);
        const projectMetadata = listProjects(dataRoot).find(
          ({ name }) => name === projectName,
        );
        if (projectMetadata === undefined) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }

        if (options.mode !== undefined) {
          const mode = parseRetrievalMode(options.mode);
          if (options.maxDepth !== undefined && mode !== 'hierarchical') {
            throw new InputError('--max-depth is only supported with hierarchical mode.', {
              suggestedAction: 'Use --mode hierarchical with --max-depth.',
            });
          }
          const results = searchProjectDocuments({
            projectRoot: join(dataRoot, 'projects', projectName),
            project: projectMetadata,
            projectId: projectMetadata.id,
            query,
            mode,
            maxDepth: parseOptionalLimit(options.maxDepth, 'Maximum depth'),
            maxResults: parseOptionalLimit(options.maxResults, 'Maximum results'),
          });
          writeOut(`Search results (${mode}) for ${JSON.stringify(query)}:\n`);
          if (results.length === 0) {
            writeOut('No matching documents found.\n');
            return;
          }
          for (const result of results) {
            writeOut(
              `- ${result.path} — ${result.title}\n` +
                `  ${result.snippet}\n` +
                `  Sources: ${result.sourceIds.join(', ') || 'none'}; ` +
                `sections: ${result.matchedSections.join(', ') || 'none'}; ` +
                `estimated tokens: ${result.tokenCount}\n`,
            );
          }
          return;
        }

        if (options.maxDepth !== undefined || options.maxResults !== undefined) {
          throw new InputError('Retrieval limits require an explicit --mode.', {
            suggestedAction: 'Use --mode hierarchical with --max-depth, or --mode path with --max-results.',
          });
        }

        const knowledgeRoot = join(
          dataRoot,
          'projects',
          projectName,
          'knowledge',
        );
        const results = searchMarkdownDocuments(knowledgeRoot, query);
        writeOut(`Search results for ${JSON.stringify(query)}:\n`);
        if (results.length === 0) {
          writeOut('No matching documents found.\n');
          return;
        }

        for (const result of results) {
          writeOut(`- ${result.path} — ${result.title}\n  ${result.excerpt}\n`);
        }
      });
    });
}

function parseRetrievalMode(value: string): RetrievalMode {
  if (value === 'path' || value === 'hierarchical' || value === 'fulltext') {
    return value;
  }
  throw new InputError(`Unsupported retrieval mode: ${value}`, {
    suggestedAction: 'Use --mode path, --mode hierarchical, or --mode fulltext.',
  });
}

function parseOptionalLimit(value: string | undefined, description: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit)) {
    throw new InputError(`${description} must be a non-negative integer.`);
  }
  return limit;
}

function parseTreeDepth(value: string | undefined): number {
  if (value === undefined) {
    return 5;
  }

  const depth = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(depth) || depth < 0) {
    throw new InputError('Tree depth must be a non-negative integer.', {
      suggestedAction: 'Use --depth with a whole number of 0 or greater.',
    });
  }

  return depth;
}

function renderKnowledgeTree(tree: KnowledgeTree, maximumDepth: number): string[] {
  const lines: string[] = [];
  const visit = (
    categories: CategoryTreeNode[],
    documents: DocumentTreeNode[],
  ): void => {
    for (const category of categories) {
      if (category.depth > maximumDepth) {
        continue;
      }

      lines.push(`${'  '.repeat(category.depth - 1)}${category.path}/`);
      visit(category.categories, category.documents);
    }

    for (const document of documents) {
      if (document.depth <= maximumDepth) {
        lines.push(`${'  '.repeat(document.depth - 1)}${document.path}`);
      }
    }
  };

  visit(tree.categories, tree.documents);
  return lines;
}

function hasKnowledgeEntries(tree: KnowledgeTree): boolean {
  return tree.categories.length > 0 || tree.documents.length > 0;
}

function createProjectRuntime(): ProjectCommandRuntime {
  const paths = resolveSettingsPaths();
  const settings = loadSettings({ paths });
  const logger = createApplicationLogger({
    dataRoot: paths.dataRoot,
    level: settings.logging.level,
  });

  return { dataRoot: paths.dataRoot, logger, settings };
}

function createConfiguredBuildProvider(settings: Settings): AIProvider {
  const providerName = settings.ai?.provider ?? 'openai';
  if (providerName !== 'openai' && providerName !== 'openai-compatible') {
    throw new ConfigurationError(`Unsupported AI provider for knowledge builds: ${providerName}.`, {
      suggestedAction: 'Set ai.provider to openai in config.yaml for this build command.',
    });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new ConfigurationError('The OPENAI_API_KEY environment variable is required.', {
      suggestedAction: 'Set OPENAI_API_KEY in the environment; the key is not stored in config.yaml.',
    });
  }

  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  return new OpenAICompatibleProvider({ baseUrl, apiKey });
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
