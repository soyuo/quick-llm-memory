import React, { useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { resolveSettingsPaths } from '../config/paths.js';
import { InputError, InternalError } from '../errors/qlm-error.js';
import {
  deleteProject,
  initializeProject,
  renameProject,
  setProjectArchived,
} from '../projects/manager.js';
import {
  exportProject,
  importProject,
  inspectProjectBundle,
  type ProjectTransferOperation,
  type ProjectTransferProgress,
} from '../projects/transfer.js';
import { BuildWizard } from './build-wizard.js';
import { Explorer } from './explorer.js';
import { Search } from './search.js';
import { loadTuiDashboardSnapshot } from './dashboard.js';
import type { Settings } from '../config/schema.js';
import type { AIProvider } from '../providers/provider.js';

export const TUI_SCREENS = [
  'Dashboard',
  'Projects',
  'Build',
  'Explorer',
  'Search',
  'MCP Manager',
  'Settings',
  'Logs',
] as const;

export type TuiScreen = (typeof TUI_SCREENS)[number];
export type TuiLayout = 'wide' | 'compact' | 'too-small';

type ProjectAction =
  | { kind: 'idle' }
  | { kind: 'create'; value: string }
  | { kind: 'rename'; projectName: string; value: string }
  | { kind: 'confirm-archive'; projectName: string; archived: boolean }
  | { kind: 'confirm-delete'; projectName: string; value: string }
  | { kind: 'import-source'; value: string }
  | { kind: 'import-name'; sourcePath: string; value: string }
  | { kind: 'confirm-import'; sourcePath: string; projectName: string }
  | { kind: 'export-destination'; projectName: string; value: string }
  | { kind: 'confirm-export'; projectName: string; destinationPath: string }
  | {
      kind: 'transfer';
      operation: ProjectTransferOperation;
      progress: ProjectTransferProgress;
      controller: AbortController;
    };

export function getTuiLayout(columns: number, rows: number): TuiLayout {
  if (columns < 60 || rows < 16) {
    return 'too-small';
  }

  return columns >= 100 && rows >= 24 ? 'wide' : 'compact';
}

export interface TuiAppProps {
  columns?: number;
  rows?: number;
  dataRoot?: string;
  onExit?: () => void;
  buildProviderFactory?: (settings: Settings) => AIProvider;
}

export function TuiApp({ columns, rows, dataRoot, onExit, buildProviderFactory }: TuiAppProps): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = {
    columns: columns ?? windowSize.columns ?? 80,
    rows: rows ?? windowSize.rows ?? 24,
  };
  const layout = getTuiLayout(size.columns, size.rows);
  const root = dataRoot ?? resolveSettingsPaths().dataRoot;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeScreen, setActiveScreen] = useState<TuiScreen | undefined>();
  const [selectedProjectName, setSelectedProjectName] = useState<string | undefined>();
  const [projectCursorName, setProjectCursorName] = useState<string | undefined>();
  const [projectAction, setProjectAction] = useState<ProjectAction>({ kind: 'idle' });
  const [projectMessage, setProjectMessage] = useState<string | undefined>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [focusedPane, setFocusedPane] = useState<'navigation' | 'content'>(
    'navigation',
  );
  const dashboard = useMemo(
    () => loadTuiDashboardSnapshot(root, selectedProjectName),
    [root, selectedProjectName, refreshVersion],
  );
  const currentProjectName = dashboard.selectedProject?.name;
  const cursorIndex = dashboard.projects.findIndex(({ name }) => name === projectCursorName);
  const selectedProjectIndex = dashboard.projects.findIndex(
    ({ name }) => name === currentProjectName,
  );
  const projectSelectionIndex = cursorIndex >= 0
    ? cursorIndex
    : Math.max(0, selectedProjectIndex);
  const { exit } = useApp();

  const startProjectTransfer = (
    operation: ProjectTransferOperation,
    details: { sourcePath: string; projectName: string } | { destinationPath: string; projectName: string },
  ): void => {
    const controller = new AbortController();
    setProjectMessage(undefined);
    setProjectAction({
      kind: 'transfer',
      operation,
      controller,
      progress: { operation, phase: 'validating', completedFiles: 0, totalFiles: 0 },
    });

    const onProgress = (progress: ProjectTransferProgress): void => {
      setProjectAction((current) => current.kind === 'transfer'
        ? { ...current, progress }
        : current);
    };

    void (async () => {
      try {
        if (operation === 'import' && 'sourcePath' in details) {
          const project = await importProject(root, details.sourcePath, details.projectName, {
            signal: controller.signal,
            onProgress,
          });
          setSelectedProjectName(project.name);
          setProjectCursorName(project.name);
          setProjectMessage(`Imported project ${project.name}.`);
        } else if (operation === 'export' && 'destinationPath' in details) {
          await exportProject(root, details.projectName, details.destinationPath, {
            signal: controller.signal,
            onProgress,
          });
          setProjectMessage(`Exported project ${details.projectName}.`);
        }
      } catch (error) {
        setProjectMessage(controller.signal.aborted
          ? 'Transfer cancelled; the destination was not changed.'
          : getSafeProjectError(error));
      } finally {
        setProjectAction({ kind: 'idle' });
        setRefreshVersion((version) => version + 1);
      }
    })();
  };

  useInput((input, key) => {
    if (activeScreen === 'Build') {
      return;
    }

    if (activeScreen === 'Explorer') {
      if (input.toLowerCase() === 'r') {
        setRefreshVersion((version) => version + 1);
      }
      return;
    }

    if (activeScreen === 'Search') {
      return;
    }

    if (activeScreen === 'Projects' && projectAction.kind !== 'idle') {
      if (key.tab) {
        return;
      }
      if (projectAction.kind === 'transfer') {
        if (key.escape) {
          projectAction.controller.abort();
          setProjectMessage('Cancelling transfer; waiting for a safe stop before commit.');
        }
        return;
      }
      if (key.escape) {
        setProjectAction({ kind: 'idle' });
        setProjectMessage('Project action cancelled.');
        return;
      }

      if (projectAction.kind === 'confirm-archive') {
        if (input.toLowerCase() === 'y') {
          try {
            setProjectArchived(root, projectAction.projectName, projectAction.archived);
            setRefreshVersion((version) => version + 1);
            setProjectCursorName(projectAction.projectName);
            setProjectMessage(projectAction.archived
              ? `Archived project ${projectAction.projectName}.`
              : `Restored project ${projectAction.projectName}.`);
          } catch (error) {
            setProjectMessage(getSafeProjectError(error));
          }
          setProjectAction({ kind: 'idle' });
        } else if (input.toLowerCase() === 'n') {
          setProjectAction({ kind: 'idle' });
          setProjectMessage('Project action cancelled.');
        }
        return;
      }

      if (projectAction.kind === 'confirm-delete') {
        if (key.backspace || key.delete) {
          setProjectAction({ ...projectAction, value: projectAction.value.slice(0, -1) });
        } else if (key.return) {
          if (projectAction.value !== projectAction.projectName) {
            setProjectMessage('The project name did not match; nothing was deleted.');
            return;
          }
          try {
            deleteProject(root, projectAction.projectName, projectAction.value);
            if (selectedProjectName === projectAction.projectName) {
              setSelectedProjectName(undefined);
            }
            setProjectCursorName(undefined);
            setRefreshVersion((version) => version + 1);
            setProjectMessage(`Deleted project ${projectAction.projectName}.`);
          } catch (error) {
            setProjectMessage(getSafeProjectError(error));
          }
          setProjectAction({ kind: 'idle' });
        } else if (isTextInput(input, key)) {
          setProjectAction({ ...projectAction, value: projectAction.value + input });
          setProjectMessage(undefined);
        }
        return;
      }

      if (projectAction.kind === 'confirm-import') {
        if (input.toLowerCase() === 'y') {
          startProjectTransfer('import', projectAction);
        } else if (input.toLowerCase() === 'n') {
          setProjectAction({ kind: 'idle' });
          setProjectMessage('Import cancelled.');
        }
        return;
      }

      if (projectAction.kind === 'confirm-export') {
        if (input.toLowerCase() === 'y') {
          startProjectTransfer('export', projectAction);
        } else if (input.toLowerCase() === 'n') {
          setProjectAction({ kind: 'idle' });
          setProjectMessage('Export cancelled.');
        }
        return;
      }

      if (projectAction.kind === 'import-source') {
        if (key.backspace || key.delete) {
          setProjectAction({ ...projectAction, value: projectAction.value.slice(0, -1) });
        } else if (key.return) {
          void inspectProjectBundle(projectAction.value).then((metadata) => {
            setProjectAction({
              kind: 'import-name',
              sourcePath: projectAction.value,
              value: metadata.name,
            });
            setProjectMessage(undefined);
          }).catch((error: unknown) => {
            setProjectMessage(getSafeProjectError(error));
          });
        } else if (isTextInput(input, key)) {
          setProjectAction({ ...projectAction, value: projectAction.value + input });
        }
        return;
      }

      if (projectAction.kind === 'import-name') {
        if (key.backspace || key.delete) {
          setProjectAction({ ...projectAction, value: projectAction.value.slice(0, -1) });
        } else if (key.return) {
          setProjectAction({
            kind: 'confirm-import',
            sourcePath: projectAction.sourcePath,
            projectName: projectAction.value,
          });
        } else if (isTextInput(input, key)) {
          setProjectAction({ ...projectAction, value: projectAction.value + input });
        }
        return;
      }

      if (projectAction.kind === 'export-destination') {
        if (key.backspace || key.delete) {
          setProjectAction({ ...projectAction, value: projectAction.value.slice(0, -1) });
        } else if (key.return) {
          setProjectAction({
            kind: 'confirm-export',
            projectName: projectAction.projectName,
            destinationPath: projectAction.value,
          });
        } else if (isTextInput(input, key)) {
          setProjectAction({ ...projectAction, value: projectAction.value + input });
        }
        return;
      }

      if (key.backspace || key.delete) {
        setProjectAction({ ...projectAction, value: projectAction.value.slice(0, -1) });
      } else if (key.return) {
        try {
          if (projectAction.kind === 'create') {
            const project = initializeProject(root, projectAction.value);
            setProjectCursorName(project.name);
            setSelectedProjectName(project.name);
            setRefreshVersion((version) => version + 1);
            setProjectMessage(`Created project ${project.name}.`);
          } else {
            const project = renameProject(root, projectAction.projectName, projectAction.value);
            setProjectCursorName(project.name);
            if (selectedProjectName === projectAction.projectName) {
              setSelectedProjectName(project.name);
            }
            setRefreshVersion((version) => version + 1);
            setProjectMessage(`Renamed project to ${project.name}.`);
          }
          setProjectAction({ kind: 'idle' });
        } catch (error) {
          setProjectMessage(getSafeProjectError(error));
        }
      } else if (isTextInput(input, key)) {
        setProjectAction({ ...projectAction, value: projectAction.value + input });
        setProjectMessage(undefined);
      }
      return;
    }

    if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
      onExit?.();
      exit();
      return;
    }

    if (key.escape) {
      setActiveScreen(undefined);
      setFocusedPane('navigation');
      setRefreshVersion((version) => version + 1);
      return;
    }

    if (key.tab) {
      setFocusedPane((current) =>
        current === 'navigation' ? 'content' : 'navigation',
      );
      return;
    }

    if (input.toLowerCase() === 'r') {
      setRefreshVersion((version) => version + 1);
      return;
    }

    if (activeScreen === 'Projects' && focusedPane === 'content') {
      if (key.upArrow && dashboard.projects.length > 0) {
        const index = projectSelectionIndex === 0
          ? dashboard.projects.length - 1
          : projectSelectionIndex - 1;
        setProjectCursorName(dashboard.projects[index]?.name);
        return;
      }
      if (key.downArrow && dashboard.projects.length > 0) {
        const index = (projectSelectionIndex + 1) % dashboard.projects.length;
        setProjectCursorName(dashboard.projects[index]?.name);
        return;
      }
      if (key.return) {
        const project = dashboard.projects[projectSelectionIndex];
        if (project !== undefined) {
          setProjectCursorName(project.name);
          setSelectedProjectName(project.name);
          setActiveScreen('Dashboard');
          setSelectedIndex(TUI_SCREENS.indexOf('Dashboard'));
        }
        return;
      }

      const project = dashboard.projects[projectSelectionIndex];
      if (input.toLowerCase() === 'c') {
        setProjectMessage(undefined);
        setProjectAction({ kind: 'create', value: '' });
        return;
      }
      if (input.toLowerCase() === 'i') {
        setProjectMessage(undefined);
        setProjectAction({ kind: 'import-source', value: '' });
        return;
      }
      if (project === undefined) {
        return;
      }
      if (input.toLowerCase() === 'n') {
        setProjectMessage(undefined);
        setProjectAction({ kind: 'rename', projectName: project.name, value: '' });
      } else if (input.toLowerCase() === 'a') {
        setProjectMessage(undefined);
        setProjectAction({
          kind: 'confirm-archive',
          projectName: project.name,
          archived: project.archived_at === undefined,
        });
      } else if (input.toLowerCase() === 'd') {
        setProjectMessage(undefined);
        setProjectAction({ kind: 'confirm-delete', projectName: project.name, value: '' });
      } else if (input.toLowerCase() === 'e') {
        setProjectMessage(undefined);
        setProjectAction({ kind: 'export-destination', projectName: project.name, value: '' });
      }
      return;
    }

    if (key.upArrow && focusedPane === 'navigation') {
      setSelectedIndex((current) =>
        current === 0 ? TUI_SCREENS.length - 1 : current - 1,
      );
      return;
    }

    if (key.downArrow && focusedPane === 'navigation') {
      setSelectedIndex((current) => (current + 1) % TUI_SCREENS.length);
      return;
    }

    if (key.return) {
      const screen = TUI_SCREENS[selectedIndex];
      if (screen === 'Dashboard') {
        setRefreshVersion((version) => version + 1);
      }
      if (screen === 'Projects') {
        setProjectCursorName(currentProjectName ?? dashboard.projects[0]?.name);
      }
      setActiveScreen(screen);
      setFocusedPane('content');
    }
  });

  const navigation = (
    <Box flexDirection="column" width={layout === 'wide' ? 24 : undefined}>
      <Text bold>Navigation{focusedPane === 'navigation' ? ' [focus]' : ''}</Text>
      {TUI_SCREENS.map((screen, index) => (
        <Text key={screen}>
          {index === selectedIndex ? '› ' : '  '}
          {screen}
          {index === selectedIndex ? ' [selected]' : ''}
        </Text>
      ))}
    </Box>
  );

  const content = (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold>
        {activeScreen ?? 'Dashboard'}
        {focusedPane === 'content' ? ' [focus]' : ''}
      </Text>
      {activeScreen === undefined || activeScreen === 'Dashboard' ? (
        <>
          <Text>Projects: {dashboard.projects.length}</Text>
          {dashboard.error ? <Text>{dashboard.error}</Text> : null}
          {currentProjectName === undefined ? (
            <Text>No projects yet. Use qlm init &lt;name&gt; to create one.</Text>
          ) : (
            <>
              <Text>Selected project: {currentProjectName}</Text>
              {dashboard.projectSummaryAvailable ? (
                <Text>Knowledge: {dashboard.categoryCount} categories, {dashboard.documentCount} documents</Text>
              ) : (
                <Text>Project summary is unavailable.</Text>
              )}
            </>
          )}
          <Text>Recent activity:</Text>
          {dashboard.recentActivities.length === 0 ? (
            <Text>No recent project or error activity recorded.</Text>
          ) : dashboard.recentActivities.map((activity, index) => (
            <Text key={`${activity.kind}-${index}`}>{activity.summary}</Text>
          ))}
          <Text>{dashboard.buildSummary}</Text>
          <Text>{dashboard.mcpSummary}</Text>
          <Text>Press r to refresh dashboard data.</Text>
        </>
      ) : activeScreen === 'Projects' ? (
        <>
          <Text>Projects: {dashboard.projects.length}</Text>
          {dashboard.projects.length === 0 ? (
            <Text>No projects yet. Use qlm init &lt;name&gt; to create one.</Text>
          ) : dashboard.projects.map((project, index) => (
            <Text key={project.id}>
              {index === projectSelectionIndex ? '› ' : '  '}
              {project.name}
              {project.archived_at === undefined ? '' : ' [archived]'}
              {project.name === currentProjectName ? ' [selected project]' : ''}
            </Text>
          ))}
          {projectAction.kind === 'create' ? (
            <Text>New project name: {projectAction.value}_ (Enter create, Esc cancel)</Text>
          ) : null}
          {projectAction.kind === 'rename' ? (
            <Text>Rename {projectAction.projectName} to: {projectAction.value}_ (Enter save, Esc cancel)</Text>
          ) : null}
          {projectAction.kind === 'confirm-archive' ? (
            <Text>
              {projectAction.archived ? 'Archive' : 'Restore'} project {projectAction.projectName}? Press y to confirm, n to cancel.
            </Text>
          ) : null}
          {projectAction.kind === 'confirm-delete' ? (
            <Text>
              Delete {projectAction.projectName}? Type the exact name: {projectAction.value}_ (Enter delete, Esc cancel)
            </Text>
          ) : null}
          {projectAction.kind === 'import-source' ? (
            <Text>Import from project directory: {projectAction.value}_ (Enter continue, Esc cancel)</Text>
          ) : null}
          {projectAction.kind === 'import-name' ? (
            <Text>Import as project name: {projectAction.value}_ (Enter continue, Esc cancel)</Text>
          ) : null}
          {projectAction.kind === 'confirm-import' ? (
            <Text>
              Valid project directory. Import as {projectAction.projectName}? Press y to copy, Esc to cancel.
            </Text>
          ) : null}
          {projectAction.kind === 'export-destination' ? (
            <Text>Export {projectAction.projectName} to new directory: {projectAction.value}_ (Enter continue, Esc cancel)</Text>
          ) : null}
          {projectAction.kind === 'confirm-export' ? (
            <Text>
              Export {projectAction.projectName} to the entered directory? Existing paths are preserved. Press y to copy, Esc to cancel.
            </Text>
          ) : null}
          {projectAction.kind === 'transfer' ? (
            <Text>
              {projectAction.progress.phase === 'validating'
                ? `Validating ${projectAction.operation} source and destination...`
                : projectAction.progress.phase === 'copying'
                  ? `${projectAction.operation === 'import' ? 'Importing' : 'Exporting'} files ${projectAction.progress.completedFiles}/${projectAction.progress.totalFiles}... Esc cancels before commit.`
                  : `Ready to commit ${projectAction.operation}; press Esc to cancel.`}
            </Text>
          ) : null}
          {projectMessage ? <Text>{projectMessage}</Text> : null}
          <Text>Arrows choose; Enter selects; c create; n rename; a archive/restore; d delete; i import; e export.</Text>
        </>
      ) : activeScreen === 'Build' ? (
        <BuildWizard
          dataRoot={root}
          providerFactory={buildProviderFactory}
          onBuildComplete={(projectName) => {
            setSelectedProjectName(projectName);
            setRefreshVersion((version) => version + 1);
          }}
          onCancel={() => {
            setActiveScreen(undefined);
            setFocusedPane('navigation');
          }}
        />
      ) : activeScreen === 'Explorer' ? (
        <Explorer
          dataRoot={root}
          projectName={currentProjectName}
          refreshVersion={refreshVersion}
          onBack={() => {
            setActiveScreen(undefined);
            setFocusedPane('navigation');
          }}
          onExit={onExit}
        />
      ) : activeScreen === 'Search' ? (
        <Search
          dataRoot={root}
          initialProjectName={currentProjectName}
          refreshVersion={refreshVersion}
          onBack={() => {
            setActiveScreen(undefined);
            setFocusedPane('navigation');
          }}
          onExit={onExit}
        />
      ) : (
        <Text>{activeScreen} screen is not available yet.</Text>
      )}
      {activeScreen ? <Text>Press Esc to return to navigation.</Text> : null}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>quick-llm-memory</Text>
      {layout === 'too-small' ? (
        <Text>
          Terminal too small ({size.columns}x{size.rows}); minimum is 60x16. Resize or press q to quit.
        </Text>
      ) : (
        <Box flexDirection={layout === 'wide' ? 'row' : 'column'} gap={2}>
          {navigation}
          {content}
        </Box>
      )}
      <Text dimColor>
        ↑/↓ Navigate  Enter Select  Tab Switch pane  Esc Back  r Refresh  q Quit
      </Text>
    </Box>
  );
}

function isTextInput(
  input: string,
  key: {
    ctrl?: boolean;
    meta?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
  },
): boolean {
  return input.length > 0 && !key.ctrl && !key.meta && !key.upArrow
    && !key.downArrow && !key.leftArrow && !key.rightArrow;
}

function getSafeProjectError(error: unknown): string {
  if (error instanceof InputError || error instanceof InternalError) {
    return error.message;
  }
  return 'Project action failed. Refresh and check project data and permissions.';
}

export async function launchTui(dataRoot = resolveSettingsPaths().dataRoot): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InputError('The interactive TUI requires a terminal.', {
      suggestedAction: 'Run a qlm subcommand or attach an interactive terminal.',
    });
  }

  await render(<TuiApp dataRoot={dataRoot} />).waitUntilExit();
}
