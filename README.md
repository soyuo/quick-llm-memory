# Quick LLM Memory

Quick LLM Memory (QLM) turns a folder of source documents into a searchable, local knowledge base. It organizes generated Markdown knowledge alongside your project, indexes it for retrieval, and exposes it through a terminal interface, command line, and MCP server.

QLM is local-first: project files and its search index are stored on your computer. An AI provider is used when building knowledge and, depending on search mode, for embeddings. Your source documents remain yours and are not replaced by generated knowledge.

## Requirements

- Windows 10 or 11, macOS, or Linux.
- Node.js `^24.11.0` or `>=26.0.0` (Node.js 25 is not supported).
- Python and a working C/C++ build toolchain for native npm dependencies:
  - Windows: Visual Studio C++ Build Tools.
  - macOS: Xcode Command Line Tools.
  - Linux: `make` and a C/C++ compiler.
- An OpenAI API key for AI knowledge generation. OpenAI-compatible endpoints can also be configured.

## Install from source

```sh
git clone https://github.com/soyuo/quick-llm-memory.git
cd quick-llm-memory
npm install
npm run build
npm link
```

`npm link` makes the `qlm` command available in your shell. Run `qlm --help` to see the command list. To update, pull the latest source and repeat `npm install`, `npm run build`, and `npm link`.

## Quick start

Set your API key in the environment. Keep it out of `config.yaml` and source control.

```sh
# macOS / Linux
export OPENAI_API_KEY="your-api-key"

# Windows PowerShell
$env:OPENAI_API_KEY = "your-api-key"
```

Create a project, then build knowledge from a folder of source files:

```sh
qlm init product-notes
qlm build ./docs --project product-notes
qlm search "account setup" --project product-notes --mode hybrid
qlm
```

The final command opens the interactive TUI when run in a terminal without a subcommand.

## Terminal interface (TUI)

The TUI has eight screens. Use the screen navigation keys shown in its footer; arrow keys move through lists and `Enter` opens or selects an item.

| Screen | What you can do |
| --- | --- |
| Dashboard | See project totals, recent projects, and recent errors. |
| Projects | Create, rename, archive/restore, import, export, or delete projects. Deletion asks you to type the exact project name. |
| Build | Choose a project and source, review a generation preview, and explicitly confirm before generated files are applied. Resolve file conflicts by keeping, applying, comparing, merging in an editor, or excluding the generated file. |
| Explorer | Browse the knowledge tree, open documents, view related documents, copy a path, or open a file in your editor. |
| Search | Search project knowledge using available retrieval modes and open matching documents. |
| MCP Manager | Configure supported MCP clients, copy setup snippets, check a stdio connection, and start, inspect, or stop the HTTP server. |
| Settings | Edit provider, model, embedding model, generation-cache, and logging settings. |
| Logs | Currently unavailable until implemented. |

Use `qlm` from a terminal at least 60 columns by 16 rows; 100 by 24 or larger gives the full layout. See [docs/tui.md](docs/tui.md) for keyboard controls and workflow details.

## Command line (CLI)

Run `qlm --help` for the complete syntax. Common commands:

| Command | Purpose |
| --- | --- |
| `qlm init <name>` | Create a project. |
| `qlm build <source> --project <name>` | Generate or update project knowledge from source files. |
| `qlm project list [--json]` | List projects (optionally as JSON). |
| `qlm project info <name>` | Show project details. |
| `qlm project remove <name> --yes` | Remove a project after explicit confirmation. |
| `qlm project import <source> [--name <name>]` | Import a project bundle. |
| `qlm project export <name> <destination>` | Export a project bundle. |
| `qlm tree --project <name> [--depth <number>]` | Print the knowledge tree. |
| `qlm read <path> --project <name>` | Read a knowledge document. |
| `qlm search <query> --project <name> [--mode <mode>]` | Search project knowledge. Modes include `path`, `hierarchical`, `fulltext`, `semantic`, and `hybrid`. |
| `qlm validate --project <name>` | Check project knowledge and index consistency. |
| `qlm reindex --project <name> [--no-embeddings]` | Rebuild the search index; `--no-embeddings` uses lexical indexing only. |
| `qlm snapshot create <name>` | Create a project snapshot. Use `snapshot list <name>` to list snapshots and `snapshot restore <name> <snapshot-id>` to restore one (requires confirmation or `--yes`). |
| `qlm mcp serve [--transport stdio\|http]` | Run the MCP server. |
| `qlm mcp config <claude-code\|cursor\|vscode>` | Print client setup configuration. |

Examples:

```sh
qlm project list --json
qlm tree --project product-notes --depth 3
qlm search "release process" --project product-notes --mode hybrid --max-results 5
qlm validate --project product-notes
qlm snapshot create product-notes
```

Semantic search needs an embedding-capable provider and indexed embeddings. Hybrid search can fall back to lexical retrieval when embedding configuration is unavailable. Search limits such as `--max-results` require an explicit `--mode`. `qlm mcp --help` shows the MCP approval and server management commands; see [docs/mcp.md](docs/mcp.md) for client setup and transport details.

## Configuration

QLM creates `config.yaml` under the operating system's user configuration directory:

| OS | Configuration file |
| --- | --- |
| Windows | `%APPDATA%\quick-llm-memory\config\config.yaml` |
| macOS | `~/Library/Preferences/quick-llm-memory/config/config.yaml` |
| Linux | `$XDG_CONFIG_HOME/quick-llm-memory/config/config.yaml`, or `~/.config/quick-llm-memory/config/config.yaml` when `XDG_CONFIG_HOME` is unset. |

Example settings:

```yaml
ai:
  provider: openai
  model: gpt-4.1-mini
  embedding_model: text-embedding-3-small
  cache_generation: true
logging:
  level: info
```

`provider` may be `openai` or `openai-compatible`. The model is provider-dependent; set a model supported by your endpoint. `cache_generation` is enabled by default and caches generation results locally; disable it if you do not want those results cached. Set `OPENAI_API_KEY` in the environment. For an OpenAI-compatible endpoint, also set `OPENAI_BASE_URL` (defaults to `https://api.openai.com/v1`). Secrets are not stored in the YAML file.

Project data defaults to the operating system's local application-data directory. Set `QLM_HOME` to choose a different data root; this does not move the configuration file. Existing data is not moved automatically. See [docs/mcp.md](docs/mcp.md), [docs/tui.md](docs/tui.md), and [docs/standalone.md](docs/standalone.md) for more details.

## Development

```sh
npm run typecheck
npm test
npm run build
```
