import React, { useState } from 'react';
import { Box, Text, render, useApp, useInput, useWindowSize } from 'ink';
import { InputError } from '../errors/qlm-error.js';

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
  onExit?: () => void;
}

export function TuiApp({ columns, rows, onExit }: TuiAppProps): React.JSX.Element {
  const windowSize = useWindowSize();
  const size = {
    columns: columns ?? windowSize.columns ?? 80,
    rows: rows ?? windowSize.rows ?? 24,
  };
  const layout = getTuiLayout(size.columns, size.rows);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeScreen, setActiveScreen] = useState<TuiScreen | undefined>();
  const [focusedPane, setFocusedPane] = useState<'navigation' | 'content'>(
    'navigation',
  );
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
      return;
    }

    if (key.tab) {
      setFocusedPane((current) =>
        current === 'navigation' ? 'content' : 'navigation',
      );
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
      setActiveScreen(TUI_SCREENS[selectedIndex]);
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
        {activeScreen ?? 'Quick LLM Memory'}
        {focusedPane === 'content' ? ' [focus]' : ''}
      </Text>
      <Text>
        {activeScreen
          ? `${activeScreen} screen is not available yet.`
          : 'Select a screen with ↑/↓ and press Enter.'}
      </Text>
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
        ↑/↓ Navigate  Enter Select  Tab Switch pane  Esc Back  q Quit
      </Text>
    </Box>
  );
}

export async function launchTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new InputError('The interactive TUI requires a terminal.', {
      suggestedAction: 'Run a qlm subcommand or attach an interactive terminal.',
    });
  }

  await render(<TuiApp />).waitUntilExit();
}
