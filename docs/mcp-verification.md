# MCP Integration Verification

Run the local stdio integration check with:

```sh
npm run verify:mcp
```

The command builds the CLI, creates an isolated temporary `QLM_HOME`, initializes a fixture project, indexes one local Markdown document, and connects an MCP client to the built `qlm mcp serve --transport stdio` process. Its child processes receive an environment allowlist and a preload guard that rejects non-loopback TCP/UDP connections and external DNS resolution.

The check verifies MCP initialization and ping, discovery of the read tools and the pending-proposal tool, project listing, bounded tree browsing, full-text search, document read, resource listing/reading, and discovery/use of all five prompts. It confirms a proposal is visible but does not modify Markdown, traversal outside the selected project is rejected, and corrupted snapshot list/restore operations fail without changing Markdown or the SQLite index; it then rebuilds the index and confirms reads still work. Transport-specific hostile-origin/auth, rate-limit, permission-denial, and access-log redaction regressions are covered by `npm test` in `test/mcp/mcp-server.test.ts` and related MCP suites.

A successful run prints:

```text
MCP stdio verification passed: tools, resources, prompts, proposal safety, traversal denial, and snapshot recovery.
```

The client speaks JSON-RPC over the server's real stdio transport, so startup output on stdout that is not protocol traffic causes the check to fail. The temporary fixture is removed on success or failure.
