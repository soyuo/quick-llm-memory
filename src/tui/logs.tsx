import { spawn } from 'node:child_process';
import React, { useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { resolveLogFilePath } from '../logging/logger.js';
import {
  filterApplicationLogs,
  formatSanitizedLogExport,
  readApplicationLogs,
  type ApplicationLogView,
} from '../logging/log-reader.js';
import { parseEditorCommand } from './editor-command.js';
import { sanitizeTerminalText } from './terminal-text.js';

const VIEWS: ApplicationLogView[] = ['all', 'operations', 'errors', 'mcp'];

export interface LogsProps {
  dataRoot: string;
  onBack?: () => void;
  onExit?: () => void;
  copyText?: (text: string) => void;
  editorCommand?: string;
}

export function Logs({
  dataRoot,
  onBack,
  onExit,
  copyText = writeClipboardText,
  editorCommand = process.env.VISUAL ?? process.env.EDITOR,
}: LogsProps): React.JSX.Element {
  const { suspendTerminal, exit } = useApp();
  const [refresh, setRefresh] = useState(0);
  const [viewIndex, setViewIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<string | undefined>();
  const snapshot = useMemo(() => readApplicationLogs(dataRoot), [dataRoot, refresh]);
  const view = VIEWS[viewIndex] ?? 'all';
  const entries = filterApplicationLogs(snapshot.entries, view);

  useInput((input, key) => {
    if (key.escape) {
      onBack?.();
      return;
    }
    if (input.toLowerCase() === 'q') {
      onExit?.();
      exit();
      return;
    }
    if (input.toLowerCase() === 'r') {
      setRefresh((current) => current + 1);
      setCursor(0);
      setMessage('Logs refreshed.');
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      setViewIndex((current) => (current + (key.leftArrow ? VIEWS.length - 1 : 1)) % VIEWS.length);
      setCursor(0);
      setMessage(undefined);
      return;
    }
    if (key.upArrow && entries.length > 0) {
      setCursor((current) => current === 0 ? entries.length - 1 : current - 1);
      return;
    }
    if (key.downArrow && entries.length > 0) {
      setCursor((current) => (current + 1) % entries.length);
      return;
    }
    if (input.toLowerCase() === 'x') {
      const excerpt = formatSanitizedLogExport(entries);
      if (excerpt.length === 0) {
        setMessage('There are no log entries to export.');
      } else {
        try {
          copyText(excerpt);
          setMessage('Copied a sanitized excerpt of up to 50 log entries.');
        } catch {
          setMessage('Could not copy the sanitized log excerpt.');
        }
      }
      return;
    }
    if (input.toLowerCase() === 'e') {
      if (snapshot.status !== 'ready' || readApplicationLogs(dataRoot).status !== 'ready') {
        setMessage('The application log file is unavailable.');
        return;
      }
      if (editorCommand === undefined || editorCommand.trim().length === 0) {
        setMessage('No external editor is configured. Set EDITOR or VISUAL, then try again.');
        return;
      }
      const args = parseEditorCommand(editorCommand);
      const [command, ...editorArgs] = args ?? [];
      if (command === undefined) {
        setMessage('The configured editor command is invalid.');
        return;
      }
      setMessage('Opening the application log in the configured editor.');
      void (async () => {
        let opened = false;
        await suspendTerminal(async () => {
          opened = await new Promise<boolean>((resolve) => {
            const child = spawn(command, [...editorArgs, resolveLogFilePath(dataRoot)], {
              stdio: 'inherit',
              shell: false,
            });
            child.once('error', () => resolve(false));
            child.once('exit', (code) => resolve(code === 0));
          });
        });
        setMessage(opened ? 'Returned from the editor.' : 'Could not open the log file in the configured editor.');
      })().catch(() => setMessage('Could not open the log file in the configured editor.'));
      return;
    }
  });

  const selected = entries[cursor];
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Application Logs</Text>
      <Text>View: {view}  ({entries.length} entries){snapshot.truncated ? '  Earlier entries omitted' : ''}</Text>
      {snapshot.status === 'missing' ? <Text>No application log has been written yet.</Text> : null}
      {snapshot.status === 'unavailable' ? <Text>Application log is unavailable or is not a regular file.</Text> : null}
      {view === 'mcp' ? <Text>MCP tool calls are not recorded in the application log.</Text> : null}
      {entries.length === 0 && snapshot.status === 'ready' && view !== 'mcp'
        ? <Text>No entries match this view.</Text>
        : null}
      {entries.slice(Math.max(0, cursor - 4), cursor + 6).map((entry, index) => {
        const entryIndex = Math.max(0, cursor - 4) + index;
        return (
          <Text key={`${entry.timestamp}-${entry.index}`}>
            {entryIndex === cursor ? '› ' : '  '}{sanitizeTerminalText(entry.timestamp)} [{entry.level}] {sanitizeTerminalText(entry.summary)}
          </Text>
        );
      })}
      {selected === undefined ? null : <Text dimColor>Selected {cursor + 1} of {entries.length}</Text>}
      {message ? <Text>{sanitizeTerminalText(message)}</Text> : null}
      <Text dimColor>Tab/arrows change view  ↑/↓ select  r refresh  e open log  x copy sanitized excerpt  Esc back  q quit</Text>
    </Box>
  );
}

function writeClipboardText(text: string): void {
  process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`);
}
