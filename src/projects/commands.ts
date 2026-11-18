import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { ConfigurationError } from '../config/error.js';
import { loadSettings } from '../config/settings.js';
import { resolveSettingsPaths } from '../config/paths.js';
import { InputError } from '../errors/qlm-error.js';
import type { Settings } from '../config/schema.js';
import { createProjectSnapshot, listProjectFilePaths, listProjectSnapshots, recoverInterruptedProjectRestore, restoreProjectSnapshot } from './snapshots.js';
import { rebuildProjectIndex, rebuildProjectIndexWithEmbeddings } from '../database/reindex.js';
import {
  createApplicationLogger,
  logApplicationError,
  logProjectCreated,
  logProjectReindexed,
  type ApplicationLogger,
} from '../logging/logger.js';
import { validateInternalLinks } from '../markdown/link-validator.js';
import { createConfiguredBuildProvider } from '../providers/configured-build-provider.js';
import { isEmbeddingProvider, type AIProvider, type EmbeddingProvider } from '../providers/provider.js';
import { searchMarkdownDocuments } from '../markdown/search.js';
import {
  searchProjectDocuments,
  type RetrievalMode,
  type RetrievalSearchResult,
} from '../retrieval/search.js';
import { selectRetrievalResultsWithinTokenBudget } from '../retrieval/token-budget.js';
import {
  buildKnowledgeTree,
  type CategoryTreeNode,
  type DocumentTreeNode,
  type KnowledgeTree,
} from '../markdown/tree.js';
import { deleteProject, initializeProject, listProjects } from './manager.js';
import { exportProject, importProject, inspectProjectBundle } from './transfer.js';
import { readStoredMarkdownDocument } from '../markdown/repository.js';
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
  confirmSnapshotRestore?: (paths: readonly string[]) => Promise<boolean>;
}

export function registerProjectCommands(
  cli: Command,
  options: ProjectCommandOptions = {},
): void {
  const runtimeFactory = options.runtimeFactory ?? createProjectRuntime;
  const providerFactory = options.providerFactory ?? createConfiguredBuildProvider;
  const writeOut = options.writeOut ?? ((text) => process.stdout.write(text));

  const snapshot = cli.command('snapshot').description('Create and list project snapshots');
  snapshot.command('create <project>').description('Create a verified project snapshot').action(async (projectName: string) => {
    await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
      const project = listProjects(dataRoot).find(({ name }) => name === validateProjectName(projectName));
      if (!project) throw new InputError(`Project not found: ${projectName}`);
      const result = createProjectSnapshot(dataRoot, project.id, project.name);
      writeOut(`Created snapshot ${result.id} for ${project.name} (${result.files.length} files).\n`);
    });
  });
  snapshot.command('list <project>').description('List and verify project snapshots').action(async (projectName: string) => {
    await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
      const project = listProjects(dataRoot).find(({ name }) => name === validateProjectName(projectName));
      if (!project) throw new InputError(`Project not found: ${projectName}`);
      const results = listProjectSnapshots(dataRoot, project.id);
      writeOut(results.length ? results.map(({ id, createdAt, files }) => `${id} ${createdAt} ${files.length} files`).join('\n') + '\n' : `No snapshots for ${project.name}.\n`);
    });
  });
  snapshot.command('restore <project> <id>').description('Restore a verified project snapshot')
    .option('--yes', 'confirm replacing project files')
    .action(async (projectName: string, snapshotId: string, restoreOptions: { yes?: boolean }) => {
    await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
      recoverInterruptedProjectRestore(dataRoot, validateProjectName(projectName));
      const project = listProjects(dataRoot).find(({ name }) => name === validateProjectName(projectName));
      if (!project) throw new InputError(`Project not found: ${projectName}`);
      const target = listProjectSnapshots(dataRoot, project.id).find(({ id }) => id === snapshotId);
      if (!target) throw new InputError('Snapshot not found for this project.');
      const existingPaths = listProjectFilePaths(join(dataRoot, 'projects', project.name));
      const affected = [...new Set([...existingPaths, ...target.files.map(({ path }) => path)])].sort();
      writeOut(`Restore will replace project files:\n${affected.map((path) => `- ${path}`).join('\n')}\n- Rebuild the project's SQLite index files (including WAL/SHM sidecars)\n`);
      let confirmed = Boolean(restoreOptions.yes);
      if (!confirmed && options.confirmSnapshotRestore) confirmed = await options.confirmSnapshotRestore(affected);
      else if (!confirmed && stdin.isTTY) {
        const prompt = createInterface({ input: stdin, output: stdout });
        try { confirmed = (await prompt.question('Type yes to continue: ')).trim() === 'yes'; }
        finally { prompt.close(); }
      }
      if (!confirmed) throw new InputError('Snapshot restore requires explicit confirmation. Use --yes or confirm interactively.');
      const projectRoot = join(dataRoot, 'projects', project.name);
      const restored = await restoreProjectSnapshot(dataRoot, project.id, project.name, snapshotId, () => {
        rebuildProjectIndex(projectRoot, project);
      });
      writeOut(`Restored snapshot ${restored.id} for ${project.name}; rebuilt index with ${restored.files.length} snapshot files.\n`);
    });
  });

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
            cacheGeneration: settings.ai?.cache_generation ?? true,
            ...(isEmbeddingProvider(provider)
              ? { embeddingModel: settings.ai?.embedding_model ?? 'text-embedding-3-small' }
              : {}),
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

  const projectCommand = cli.command('project').description('Manage projects');

  projectCommand
    .command('list')
    .description('List initialized projects')
    .option('--json', 'Print projects as JSON')
    .action(async ({ json }: { json?: boolean }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projects = listProjects(dataRoot);
        if (json) {
          writeOut(`${JSON.stringify(projects, null, 2)}\n`);
          return;
        }
        if (projects.length === 0) {
          writeOut('No projects found.\n');
          return;
        }

        writeOut(`Projects:\n${projects.map(({ name }) => `- ${name}`).join('\n')}\n`);
      });
    });

  projectCommand
    .command('info <name>')
    .description('Show project details')
    .action(async (name: string) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(name);
        const project = listProjects(dataRoot).find((candidate) => candidate.name === projectName);
        if (project === undefined) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }
        const snapshots = listProjectSnapshots(dataRoot, project.id).length;
        writeOut(
          [
            `Name: ${project.name}`,
            `ID: ${project.id}`,
            `Created: ${project.created_at}`,
            `Updated: ${project.updated_at}`,
            `Archived: ${project.archived_at ?? 'no'}`,
            `Snapshots: ${snapshots}`,
          ].join('\n') + '\n',
        );
      });
    });

  projectCommand
    .command('remove <name>')
    .description('Delete a project after taking a snapshot')
    .option('--yes', 'confirm permanent project deletion')
    .action(async (name: string, { yes }: { yes?: boolean }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(name);
        if (!yes) {
          throw new InputError('Project deletion was not confirmed.', {
            suggestedAction: `Run qlm project remove ${projectName} --yes to delete it.`,
          });
        }
        deleteProject(dataRoot, projectName, projectName);
        writeOut(`Deleted project ${projectName}.\n`);
      });
    });

  projectCommand
    .command('export <name> <destination>')
    .description('Export a project to a new directory')
    .action(async (name: string, destination: string) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const exported = await exportProject(dataRoot, validateProjectName(name), destination);
        writeOut(`Exported project ${name} to ${exported}.\n`);
      });
    });

  projectCommand
    .command('import <source>')
    .description('Import a project from an exported directory')
    .option('--name <name>', 'Name for the imported project (default: original name)')
    .action(async (source: string, { name }: { name?: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const targetName = name ?? (await inspectProjectBundle(source)).name;
        const project = await importProject(dataRoot, source, targetName);
        writeOut(`Imported project ${project.name}.\n`);
      });
    });

  cli
    .command('read <path>')
    .description('Print a knowledge document body')
    .requiredOption('--project <name>', 'Project containing the document')
    .action(async (path: string, { project }: { project: string }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot }) => {
        const projectName = validateProjectName(project);
        if (!listProjects(dataRoot).some(({ name }) => name === projectName)) {
          throw new InputError(`Project not found: ${projectName}`, {
            suggestedAction: 'Run qlm project list to see initialized projects.',
          });
        }
        const document = readStoredMarkdownDocument(
          join(dataRoot, 'projects', projectName, 'knowledge'),
          path,
        );
        writeOut(document.body.endsWith('\n') ? document.body : `${document.body}\n`);
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
    .option('--no-embeddings', 'Rebuild lexical index without contacting an embedding provider')
    .action(async ({ project, embeddings }: { project: string; embeddings: boolean }) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot, logger, settings: runtimeSettings }) => {
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
        const settings = runtimeSettings ?? loadSettings();
        const provider = embeddings ? providerFactory(settings) : undefined;
        const result = provider !== undefined && isEmbeddingProvider(provider)
          ? await rebuildProjectIndexWithEmbeddings(projectRoot, projectMetadata, {
              provider,
              model: settings.ai?.embedding_model ?? 'text-embedding-3-small',
            })
          : rebuildProjectIndex(projectRoot, projectMetadata);
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
    .option('--mode <mode>', 'Retrieval mode: path, hierarchical, fulltext, semantic, or hybrid')
    .option('--max-depth <depth>', 'Maximum hierarchy depth')
    .option('--max-results <count>', 'Maximum number of results')
    .option('--max-tokens <count>', 'Maximum estimated context tokens')
    .option('--include-related', 'Include directly related documents (default limit: 5)')
    .option('--max-related-results <count>', 'Maximum related documents to add (0-20)')
    .action(async (
      query: string,
      options: {
        project: string;
        mode?: string;
        maxDepth?: string;
        maxResults?: string;
        maxTokens?: string;
        includeRelated?: boolean;
        maxRelatedResults?: string;
      },
    ) => {
      await withProjectRuntime(runtimeFactory, async ({ dataRoot, settings: runtimeSettings }) => {
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
          const maxTokens = parseOptionalLimit(options.maxTokens, 'Maximum tokens');
          if (options.maxDepth !== undefined && mode !== 'hierarchical') {
            throw new InputError('--max-depth is only supported with hierarchical mode.', {
              suggestedAction: 'Use --mode hierarchical with --max-depth.',
            });
          }
          const request = {
            projectRoot: join(dataRoot, 'projects', projectName),
            project: projectMetadata,
            projectId: projectMetadata.id,
            query,
            maxDepth: parseOptionalLimit(options.maxDepth, 'Maximum depth'),
            maxResults: parseOptionalLimit(options.maxResults, 'Maximum results'),
            includeRelated: options.includeRelated,
            maxRelatedResults: parseOptionalLimit(
              options.maxRelatedResults,
              'Maximum related results',
            ),
          };
          let results: RetrievalSearchResult[];
          if (mode === 'semantic') {
            results = await searchProjectDocuments({
              ...request,
              mode,
              embeddingProvider: requireEmbeddingProvider(
                providerFactory(runtimeSettings ?? loadSettings({ paths: resolveSettingsPaths() })),
              ),
              embeddingModel:
                runtimeSettings?.ai?.embedding_model ?? 'text-embedding-3-small',
            });
          } else if (mode === 'hybrid') {
            let embeddingOptions:
              | { embeddingProvider: EmbeddingProvider; embeddingModel: string }
              | undefined;
            try {
              const settings = runtimeSettings ?? loadSettings({ paths: resolveSettingsPaths() });
              const provider = providerFactory(settings);
              if (isEmbeddingProvider(provider)) {
                embeddingOptions = {
                  embeddingProvider: provider,
                  embeddingModel: settings.ai?.embedding_model ?? 'text-embedding-3-small',
                };
              }
            } catch {
              // Keep the existing lexical hybrid search when embedding setup is unavailable.
            }
            results = await searchProjectDocuments({ ...request, mode, ...embeddingOptions });
          } else {
            results = searchProjectDocuments({ ...request, mode });
          }
          const tokenBudget = maxTokens === undefined
            ? undefined
            : selectRetrievalResultsWithinTokenBudget(
              results,
              maxTokens,
            );
          const selectedResults = tokenBudget?.results ?? results;
          writeOut(`Search results (${mode}) for ${JSON.stringify(query)}:\n`);
          if (tokenBudget !== undefined) {
            writeOut(
              `Estimated token budget: ${tokenBudget.consumedTokens}/${tokenBudget.maxTokens}; ` +
                `counts are estimates.\n`,
            );
          }
          if (selectedResults.length === 0) {
            writeOut(tokenBudget === undefined
              ? 'No matching documents found.\n'
              : 'No matching documents fit the token budget.\n');
            return;
          }
          for (const [index, result] of selectedResults.entries()) {
            const tokenCount = tokenBudget?.resultTokenCounts[index] ?? result.tokenCount;
            const tokenCountLabel = tokenBudget === undefined
              ? 'estimated tokens'
              : 'estimated context tokens';
            writeOut(
              `- ${result.path} — ${result.title}\n` +
                `  ${result.snippet}\n` +
                `  Sources: ${result.sourceIds.join(', ') || 'none'}; ` +
                `sections: ${result.matchedSections.join(', ') || 'none'}; ` +
                `${tokenCountLabel}: ${tokenCount}\n` +
                (result.relatedFrom === undefined
                  ? ''
                  : `  Related to: ${result.relatedFrom.join(', ')}\n`),
            );
          }
          return;
        }

        if (
          options.maxDepth !== undefined || options.maxResults !== undefined ||
          options.maxTokens !== undefined ||
          options.includeRelated === true || options.maxRelatedResults !== undefined
        ) {
          throw new InputError('Retrieval limits require an explicit --mode.', {
            suggestedAction: 'Use an explicit --mode with retrieval limits or related-document options.',
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
  if (
    value === 'path' || value === 'hierarchical' || value === 'fulltext' ||
    value === 'semantic' || value === 'hybrid'
  ) {
    return value;
  }
  throw new InputError(`Unsupported retrieval mode: ${value}`, {
    suggestedAction:
      'Use --mode path, --mode hierarchical, --mode fulltext, --mode semantic, or --mode hybrid.',
  });
}

function requireEmbeddingProvider(provider: AIProvider): EmbeddingProvider {
  if (isEmbeddingProvider(provider)) return provider;
  throw new InputError('The configured provider does not support embeddings.', {
    suggestedAction: 'Choose an embedding-capable provider and run qlm reindex before semantic search.',
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
