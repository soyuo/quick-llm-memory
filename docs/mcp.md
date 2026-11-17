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

The TUI's **MCP Manager** can also start a detached loopback HTTP server, show its
status, and stop it (`s` to start, `u` to refresh status, `x` to stop). It records
the PID, actual server start time, host/port, command identity, and log path in
the local data directory. Status and shutdown require a matching per-instance
identity from the live server; missing or mismatched state is treated as stale,
and the manager does not signal an unverifiable PID. Normal shutdown stops new
connections and drains active work for up to five seconds; the managed server
then closes remaining connections and exits itself. The manager sends no PID
signal. Stdio remains client-managed and is not started or stopped by this HTTP
process manager.

## HTTP exposure and origins

HTTP binds to `127.0.0.1` by default. Remote binding is opt-in and requires
`--allow-remote --confirm-remote-exposure`, plus explicit `--allowed-host`
and `--allowed-origin` hostname entries. For example:

```sh
qlm mcp serve --transport http --host 0.0.0.0 --allow-remote \
  --confirm-remote-exposure --allowed-host mcp.example.com \
  --allowed-origin app.example.com
```

Host and Origin validation runs before MCP dispatch. Origin validation is not
authentication: use a trusted network boundary and authentication for remote
deployments. Requests without an Origin header remain available to non-browser
clients; browser origins outside the allowlist are rejected.
