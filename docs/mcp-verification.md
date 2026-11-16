# MCP Integration Verification

Run the local stdio integration check with:

```sh
npm run verify:mcp
```

The command builds the CLI, creates an isolated temporary `QLM_HOME`, initializes a fixture project, indexes one local Markdown document, and connects an MCP client to the built `qlm mcp serve --transport stdio` process. It uses no provider credentials or network service.

The check verifies MCP initialization and ping, discovery of all nine read-only tools, project listing, bounded tree browsing, full-text search, document read, resource listing/reading, and discovery/use of all five prompts. It also checks that traversal outside the selected project is rejected, no write tool is exposed, and the fixture Markdown and SQLite index bytes remain unchanged. A successful run prints:

```text
MCP stdio verification passed: initialization, 9 read-only tools, tree/search/read, resources, prompts, traversal denial, and unchanged files.
```

The client speaks JSON-RPC over the server's real stdio transport, so startup output on stdout that is not protocol traffic causes the check to fail. The temporary fixture is removed on success or failure.
