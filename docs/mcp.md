# MCP server

The MCP server supports stdio and Streamable HTTP. Stdio remains the default and is intended for MCP clients that launch the server as a child process:

```bash
qlm mcp serve
```

Start the optional foreground HTTP server with:

```bash
qlm mcp serve --transport http --host 127.0.0.1 --port 8765
```

The endpoint is `http://127.0.0.1:8765/mcp`. The default listener is loopback-only. This release rejects non-loopback bind hosts; explicit remote access and its additional security controls are tracked separately. The server registers the same MCP tools, resources, and prompts as stdio.

HTTP uses the SDK's stateless handler, creating a fresh MCP server for each
request. Multiple clients can use the endpoint concurrently, but the application
does not retain custom per-client session state.

Stop the foreground server with Ctrl+C or SIGTERM; the CLI closes the HTTP and MCP server handlers. Background start/stop/status controls are not part of this command yet.
