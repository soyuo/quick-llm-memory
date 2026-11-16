# Terminal UI

Run `qlm` without a subcommand in an interactive terminal to open the TUI. Existing commands such as `qlm --help`, `qlm project`, and `qlm mcp` remain available. When stdin or stdout is not a TTY, use a subcommand; the interactive screen reports that it needs a terminal.

The Dashboard shows the project count, the selected project's category and document counts, recent project/error events from a bounded log tail, and whether an MCP server is connected. Build history is marked unavailable until build events are recorded. If a project tree or project list cannot be read, the dashboard shows a generic unavailable state without a local path. In Projects, move with Up/Down and select with Enter. Press `c` to create, `n` to rename, `a` to archive or restore, and `d` to delete. Archive/restore asks for confirmation and preserves all project files. Delete requires typing the exact project name and removes only that project's directory. Press `i` to import from an existing project directory and choose a managed project name; imports assign a new project ID and update the copied index's project references. Press `e` to export the selected project directory to a new path. Both transfers reject symlinks, preserve the source, show file-copy progress, and never overwrite an existing destination. Escape cancels before the final rename. Project folders use the existing directory format with `project.yaml`, Markdown, and local index files; no archive format is introduced. Press `r` to refresh dashboard data.

The shell lists Dashboard, Projects, Build, Explorer, Search, MCP Manager, Settings, and Logs. Screens that are not implemented yet show an unavailable message.

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
| q or Ctrl+C | Quit |

At 100 columns by 24 rows or larger, navigation and content appear side by side. Narrower terminals use a single-column layout. Terminals below 60 columns or 16 rows show a resize prompt. Ink observes terminal resize events and rerenders the layout. Selection and focus use text markers so state does not depend on color.
