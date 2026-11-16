# Agent workflow

## Plan and branch

1. Before implementation, create a GitHub issue for the complete task. Describe the goal, observable acceptance criteria, and an ordered implementation plan with concrete steps.
2. Create a branch from the repository's default branch using `type/<issue-number>-<short-kebab-case-description>`. Allowed branch types: `feature`, `refactor`, `fix`, `docs`, `test`, `chore`.
3. Work through the issue plan in order. Update the issue if evidence requires changing the plan.

## Commits and push

- Use `type(scope): Summary` for every commit. Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Choose one scope from the SPEC-based list below. Use the closest area; use `docs` for repository documentation and workflow guidance.
- Commit each completed implementation step as its own coherent change, then push that commit to the task branch. Do not commit unrelated work.
- Keep summaries short and specific to the diff.

Scopes from `SPEC.md`:

| Scope | Area |
| --- | --- |
| `project` | Project lifecycle and project data |
| `knowledge` | Knowledge hierarchy, generation, and document updates |
| `retrieval` | Search, ranking, context building, and token budgets |
| `storage` | Markdown storage, SQLite index, and persistence |
| `provider` | AI and embedding provider integrations |
| `mcp` | MCP server, tools, resources, clients, and manager |
| `tui` | Terminal user interface |
| `cli` | Command-line interface |
| `config` | Application settings and configuration |
| `security` | Permissions, secrets, and input/path safety |
| `backup` | Snapshots, backup, and restore |
| `logging` | Logs, metrics, and diagnostics |
| `test` | Test infrastructure and quality checks |
| `ci` | Continuous integration and automation |
| `release` | Packaging and distribution |
| `docs` | User, developer, and repository process documentation |

## Review, pull request, and CI

1. When implementation is complete, ask a sub-agent to review the branch diff. Address actionable findings in new commits whose messages describe the code change, then push them.
2. Open a pull request to the repository's default branch and link the issue.
3. If CI checks are configured, watch them until they finish. For failures, inspect the logs, fix the cause, commit and push the fix, then wait for the checks again.
4. Merge the pull request only after review is complete and all configured CI checks pass. If no CI is configured, record that in the pull request and use the issue's acceptance criteria as the completion gate.

## Repository notes

- This project is local-first. Preserve user data and Markdown source documents when changing storage or update behavior.
- The repository may not yet contain runnable application code or CI checks. Inspect the available project scripts before choosing verification commands; do not claim checks ran when they did not.
