import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import {
  createDefaultMcpStdioServerConfig,
  createMcpClientConfig,
  formatMcpClientConfig,
  type McpClient,
} from '../mcp/client-config.js';
import { checkLocalMcpStdioServer, MCP_PROBE_TIMEOUT_MS } from '../mcp/stdio-probe.js';
import { sanitizeTerminalText } from './terminal-text.js';

const CLIENTS: readonly McpClient[] = ['claude-code', 'cursor', 'vscode'];
const LOCAL_CAPABILITIES = [
  'Projects: memory_list_projects',
  'Knowledge: memory_get_tree, memory_search, memory_read, memory_read_many',
  'Context: memory_get_context, memory_get_metadata, memory_get_related, memory_validate',
  'Prompts: explore-project, find-implementation-context, explain-architecture, review-specification, identify-dependencies',
  'Resources: read-only project Markdown resources',
];

export interface McpManagerProps {
  onBack?: () => void;
  onExit?: () => void;
  probeConnection?: (signal: AbortSignal) => Promise<string[]>;
  copyText?: (text: string) => void;
}

export function McpManager({
  onBack,
  onExit,
  probeConnection = (signal) => checkLocalMcpStdioServer({ signal }),
  copyText = writeClipboardText,
}: McpManagerProps): React.JSX.Element {
  const { exit } = useApp();
  const activeCheck = useRef<AbortController | undefined>(undefined);
  const [clientIndex, setClientIndex] = useState(0);
  const [check, setCheck] = useState<
    | { state: 'idle' | 'checking' }
    | { state: 'passed'; tools: string[] }
    | { state: 'failed'; message: string }
  >({ state: 'idle' });
  const client = CLIENTS[clientIndex] ?? CLIENTS[0];
  const config = createMcpClientConfig(client, createDefaultMcpStdioServerConfig());
  const configText = formatMcpClientConfig(config);

  useEffect(() => () => activeCheck.current?.abort(), []);

  useInput((input, key) => {
    if (input.toLowerCase() === 'q' || (key.ctrl && input.toLowerCase() === 'c')) {
      activeCheck.current?.abort();
      onExit?.();
      exit();
      return;
    }
    if (key.escape) {
      activeCheck.current?.abort();
      onBack?.();
      return;
    }
    if (check.state === 'checking') {
      return;
    }
    if (key.leftArrow || key.upArrow) {
      setClientIndex((index) => index === 0 ? CLIENTS.length - 1 : index - 1);
      setCheck({ state: 'idle' });
    } else if (key.rightArrow || key.downArrow) {
      setClientIndex((index) => (index + 1) % CLIENTS.length);
      setCheck({ state: 'idle' });
    } else if (input.toLowerCase() === 'c') {
      copyText(configText);
      setCheck({ state: 'idle' });
    } else if (input.toLowerCase() === 't') {
      const controller = new AbortController();
      activeCheck.current = controller;
      setCheck({ state: 'checking' });
      void probeConnection(controller.signal)
        .then((tools) => {
          if (!controller.signal.aborted) {
            setCheck({ state: 'passed', tools });
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setCheck({
              state: 'failed',
              message: 'Local stdio check failed or timed out. Check the installation and try again.',
            });
          }
        })
        .finally(() => {
          if (activeCheck.current === controller) {
            activeCheck.current = undefined;
          }
        });
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>MCP Manager</Text>
      <Text>Transport: stdio. The selected MCP client launches and stops its own server process.</Text>
      <Text>Connection status: client-managed; this TUI does not claim a persistent connection.</Text>
      <Text>Client: {client} (use Left/Right or Up/Down to change)</Text>
      <Text>Config target: {config.path}</Text>
      <Text>Merge this JSON under mcpServers; existing client settings are not changed:</Text>
      <Text>{sanitizeTerminalText(configText)}</Text>
      <Text>Local capabilities (read-only):</Text>
      {LOCAL_CAPABILITIES.map((capability) => (
        <Text key={capability}>{sanitizeTerminalText(capability)}</Text>
      ))}
      <Text>MCP tool-call execution logs are not recorded yet.</Text>
      {check.state === 'checking' ? (
        <Text>Checking local stdio connection (up to {MCP_PROBE_TIMEOUT_MS / 1000} seconds)...</Text>
      ) : check.state === 'passed' ? (
        <>
          <Text>Connection test passed; temporary server stopped.</Text>
          <Text>Tools reported by the server: {check.tools.join(', ') || 'none'}</Text>
        </>
      ) : check.state === 'failed' ? (
        <Text>{check.message}</Text>
      ) : null}
      <Text>Press c to copy the JSON snippet, t to run the bounded local check, Esc to return, or q to quit.</Text>
    </Box>
  );
}

function writeClipboardText(text: string): void {
  process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u0007`);
}
