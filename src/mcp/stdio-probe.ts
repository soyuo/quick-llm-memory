import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  createDefaultMcpStdioServerConfig,
  type McpStdioServerConfig,
} from './client-config.js';

export const MCP_PROBE_TIMEOUT_MS = 8_000;
const MAX_PROBE_BUFFER_BYTES = 1_048_576;

export async function checkLocalMcpStdioServer(options: {
  server?: McpStdioServerConfig;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<string[]> {
  const server = options.server ?? createDefaultMcpStdioServerConfig();
  const timeoutMs = options.timeoutMs ?? MCP_PROBE_TIMEOUT_MS;
  const transport = new StdioClientTransport({
    ...server,
    cwd: process.cwd(),
    env: safeProbeEnvironment(),
    stderr: 'ignore',
    maxBufferSize: MAX_PROBE_BUFFER_BYTES,
  });
  const client = new Client({ name: 'quick-llm-memory-tui-check', version: '1.0.0' });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;

  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('MCP probe timed out.')), timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('MCP probe cancelled.'));
        return;
      }
      if (options.signal !== undefined) {
        const abort = (): void => reject(new Error('MCP probe cancelled.'));
        options.signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
      }
    });
    const probe = async (): Promise<string[]> => {
      await client.connect(transport);
      const { tools } = await client.listTools();
      return tools.slice(0, 50).map(({ name }) => name);
    };
    return await Promise.race([probe(), timedOut, aborted]);
  } catch {
    throw new Error('Local stdio check failed or timed out. Check the installation and try again.');
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    removeAbortListener();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function safeProbeEnvironment(): Record<string, string> {
  const safeNames = /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT)$/i;
  return {
    ...Object.fromEntries(
      Object.entries(process.env).flatMap(([name, value]) => (
        safeNames.test(name) && value !== undefined ? [[name, value]] : []
      )),
    ),
    ...(process.env.QLM_HOME === undefined ? {} : { QLM_HOME: process.env.QLM_HOME }),
  };
}
