# Terminal UI

Run `qlm` without a subcommand in an interactive terminal to open the TUI. Existing commands such as `qlm --help`, `qlm project`, and `qlm mcp` remain available. When stdin or stdout is not a TTY, use a subcommand; the interactive screen reports that it needs a terminal.

The Dashboard shows the project count, the selected project's category and document counts, recent project/error events from a bounded log tail, and whether an MCP server is connected. Build history is marked unavailable until build events are recorded. If a project tree or project list cannot be read, the dashboard shows a generic unavailable state without a local path. The Projects screen lets you move through projects with Up/Down and select one with Enter. Press `r` to refresh dashboard data.

The shell lists Dashboard, Projects, Build, Explorer, Search, MCP Manager, Settings, and Logs. Screens that are not implemented yet show an unavailable message.

| Key | Action |
| --- | --- |
| Up / Down | Select a screen |
| Enter | Open the selected screen |
| Tab | Switch navigation/content focus |
| Esc | Return to screen navigation |
| r | Refresh dashboard data |
| q or Ctrl+C | Quit |

At 100 columns by 24 rows or larger, navigation and content appear side by side. Narrower terminals use a single-column layout. Terminals below 60 columns or 16 rows show a resize prompt. Ink observes terminal resize events and rerenders the layout. Selection and focus use text markers so state does not depend on color.
