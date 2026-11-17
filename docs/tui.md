# Terminal UI

Run `qlm` without a subcommand in an interactive terminal to open the TUI. Existing commands such as `qlm --help`, `qlm project`, and `qlm mcp` remain available. When stdin or stdout is not a TTY, use a subcommand; the interactive screen reports that it needs a terminal.

The Dashboard shows the project count, the selected project's category and document counts, recent project/error events from a bounded log tail, and that MCP connection status is client-managed. Build history is marked unavailable until build events are recorded. If a project tree or project list cannot be read, the dashboard shows a generic unavailable state without a local path. In Projects, move with Up/Down and select with Enter. Press `c` to create, `n` to rename, `a` to archive or restore, and `d` to delete. Archive/restore asks for confirmation and preserves all project files. Delete requires typing the exact project name and removes only that project's directory. Press `i` to import from an existing project directory and choose a managed project name; imports assign a new project ID and update the copied index's project references. Press `e` to export the selected project directory to a new path. Both transfers reject symlinks, preserve the source, show file-copy progress, and never overwrite an existing destination. Escape cancels before the final rename. Project folders use the existing directory format with `project.yaml`, Markdown, and local index files; no archive format is introduced. Press `r` to refresh dashboard data.

The shell lists Dashboard, Projects, Build, Explorer, Search, MCP Manager, Settings, and Logs. Build opens a six-step setup wizard for an existing project, Markdown sources, AI provider/model, hierarchy, and document settings. Each step validates before continuing, and moving backward preserves the draft. Analysis parses the source and plans and validates a hierarchy without generating documents or changing the project. Review the proposed structure, then explicitly confirm with `y` before generation, validation, atomic commit, and index rebuilding begin. Escape returns to the preview or cancels in-flight analysis/generation before commit. Build stage progress and failures are shown in the TUI. A completed build lists created, updated, and removed documents; returning to Dashboard refreshes the selected project's counts. The source Markdown and settings file are preserved. Settings edits the current `ai.provider`, `ai.model`, and `logging.level` fields through the existing YAML settings schema; it does not display or accept credentials, theme, key bindings, or unsupported AI settings. Use Up/Down to choose a field, Left/Right to change provider or log level, Enter to edit the model, and `s` to validate and save. Escape cancels model editing or returns to navigation. Unrelated configuration values are preserved. Logs remains unavailable until implemented.

Explorer browses the selected project's knowledge tree with fixed depth and entry bounds. Use Up/Down to select rows, Right to expand categories, Left to collapse, and Enter to expand or open a document. The document view shows frontmatter metadata and a scrollable body; Tab focuses the related-document list, and Enter opens the selected related document. Press `c` to copy the absolute path through terminal OSC 52 clipboard support. Press `e` to open the document with the `VISUAL` or `EDITOR` command, if configured. The TUI itself remains read-only. Missing documents and editor failures show safe, actionable messages.

Search queries the selected project with the existing path, hierarchical, full-text, or hybrid retrieval mode. Use Tab to focus the query, mode, project, or results; type a query and press Enter to search. Left/Right (or Up/Down) change the focused mode or project. Results are capped at 20 and show their rank score, preview, source IDs, and matched sections. Enter opens the selected Markdown document directly, without scanning the full knowledge tree. The document view shows up to ten body lines at a time and supports scrolling. Search does not rebuild a stale index automatically; rebuild the project's index from the CLI before retrying if the index is unavailable.

MCP Manager shows the supported Claude Code, Cursor, and VS Code stdio configuration targets. Use Left/Right or Up/Down to select a client and `c` to copy its JSON snippet through OSC 52; merge it into that client configuration manually. It lists the existing read-only tools, prompts, and resources. MCP tool-call execution logs are not currently recorded. Press `t` to launch a temporary local stdio server and list its tools, with an eight-second timeout and a one-megabyte protocol buffer cap. The process is stopped after the check. This is a local protocol check, not a persistent client connection. The CLI equivalent for printing a config is `qlm mcp config <client>`.

Logs reads the existing JSONL application log and shows at most the newest 200 records from a 256 KiB tail, newest first. Tab or Left/Right switches between all, operations, errors, and MCP activity; the MCP view explains that tool calls are not recorded. Entries are converted to safe summaries instead of displaying raw log fields. Press `e` to open the fixed application log path with `VISUAL` or `EDITOR` (arguments are parsed without a shell), `x` to copy up to 50 sanitized summaries from the current view, and `r` to refresh. Missing, linked, or non-regular log paths show a generic status.

## Native build requirements

Installing from source builds the small native helper used to publish project transfers atomically without replacing an existing destination. `npm install` or `npm ci` therefore needs the platform's C/C++ build tools and Python as required by [node-gyp](https://github.com/nodejs/node-gyp#installation). On Windows, install Python and Visual Studio's C++ build tools; on macOS, install Xcode Command Line Tools; on Linux, install Python, `make`, and a C/C++ compiler. Transfer publication fails closed on unsupported filesystems instead of using a non-atomic fallback.

| Key | Action |
| --- | --- |
| Up / Down | Select a screen |
| Enter | Open the selected screen |
| Tab | Switch navigation/content focus |
| Esc | Return to screen navigation |
| r | Refresh dashboard data |
| c (Projects) | Create a project |
| n (Projects) | Rename the selected project |
| a (Projects) | Confirm archive or restore |
| d (Projects) | Type the project name to confirm deletion |
| i (Projects) | Import an existing project directory |
| e (Projects) | Export the selected project to a new directory |
| Up / Down (Explorer tree) | Select a category or document |
| Right / Left (Explorer tree) | Expand / collapse a category |
| Enter (Explorer) | Expand a category or open a document |
| Up / Down or j / k (document view) | Scroll document content |
| Tab / Enter (related documents) | Focus and open a related document |
| c (Explorer) | Copy the absolute document path through OSC 52 |
| e (document view) | Open with `VISUAL` or `EDITOR` |
| Tab / Enter (Search) | Focus fields; search or open the selected result |
| Arrows (Search mode/project) | Change retrieval mode or project scope |
| Up / Down (Search results) | Select a ranked result |
| q (Search) | Quit the TUI; when query is focused, enter `q` in the query |
| Arrows (MCP Manager) | Select a supported client |
| c / t (MCP Manager) | Copy config snippet / run bounded stdio check |
| Tab / Left / Right (Logs) | Change log view |
| Up / Down (Logs) | Select a log entry |
| e (Logs) | Open the application log with `VISUAL` or `EDITOR` |
| x (Logs) | Copy a sanitized excerpt from the current view |
| Tab (Build wizard) | Move between setting fields |
| Arrow keys (Build wizard choices) | Change the provider or toggle boolean settings |
| Space (Build wizard toggles) | Toggle boolean settings |
| Enter (Build wizard) | Validate and continue; leave from the completed screen |
| Esc / Ctrl+B (Build wizard) | Go back a step; leave from the first or completed screen |
| q (Build wizard) | Type in text fields; quits from a choice or summary screen |
| q or Ctrl+C | Quit |

At 100 columns by 24 rows or larger, navigation and content appear side by side. Narrower terminals use a single-column layout. Terminals below 60 columns or 16 rows show a resize prompt. Ink observes terminal resize events and rerenders the layout. Selection and focus use text markers so state does not depend on color.

## Deterministic workflow verification

Run `npx vitest run test/tui-workflows.test.tsx` to exercise project creation, build preview and confirmation, generation progress, document browsing, search, MCP connection guidance, and terminal resizing with local fixtures. The fake provider and MCP check make no network requests and require no provider credentials. The success flow creates `e2e-project` with `notes.md`; the failure flow displays the fixture error and leaves the project's knowledge directory and database absent.
