import React, { useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { resolveSettingsPaths } from '../config/paths.js';
import { InputError } from '../errors/qlm-error.js';
import { loadTuiDashboardSnapshot } from './dashboard.js';

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
}

export function TuiApp({ columns, rows, dataRoot, onExit }: TuiAppProps): React.JSX.Element {
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

  useInput((input, key) => {
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
              {project.name === currentProjectName ? ' [selected project]' : ''}
            </Text>
          ))}
          <Text>Use arrows to choose a project and Enter to select.</Text>
        </>
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

export async function launchTui(dataRoot = resolveSettingsPaths().dataRoot): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InputError('The interactive TUI requires a terminal.', {
      suggestedAction: 'Run a qlm subcommand or attach an interactive terminal.',
    });
  }

  await render(<TuiApp dataRoot={dataRoot} />).waitUntilExit();
}
