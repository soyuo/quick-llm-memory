# Agent workflow

## Plan and branch

1. Before implementation, create a GitHub issue for the complete task. Describe the goal, observable acceptance criteria, and an ordered implementation plan with concrete steps.
2. Create a branch from the repository's default branch using `type/<issue-number>-<short-kebab-case-description>`. Allowed branch types: `feature`, `refactor`, `fix`, `docs`, `test`, `chore`.
3. Work through the issue plan in order. Update the issue if evidence requires changing the plan.

## Issue queue and phase sequencing

Before starting implementation, inspect the open issues and the nine SPEC milestones in their listed order. Work only in the earliest incomplete milestone; do not start later phases while an earlier phase remains incomplete.

Issue and milestone planning is workflow administration, not implementation. Create or refine the needed issues directly; do not require a separate parent issue, branch, commit, or pull request just to register the work. A pull request is for implemented code or documentation changes, not for issue bookkeeping alone.

- If the earliest incomplete milestone has an actionable issue, work on the earliest unblocked issue in that milestone. Check existing issues first and do not create duplicates.
- If that milestone has no actionable issues and no blocked issue awaiting an external prerequisite, break its remaining SPEC work into the smallest independently reviewable issues that together cover the milestone's stated work and completion criteria. Create those issues before implementing them.
- Create each decomposed issue with the matching template: `feature.md` for product functionality, `fix.md` for a confirmed-defect fix, `refactor.md` for internal restructuring, `documentation.md` for documentation-only work, and `task.md` for other planned work such as test or CI setup. Use `bug_report.md` only to report a defect; implementation to resolve it uses `fix.md`. Fill in the target milestone, ordered steps, acceptance criteria, dependencies, and scope boundaries. Assign the matching milestone and exactly one appropriate work-type label.
- If the only remaining issues in the earliest incomplete milestone are blocked, do not create duplicate work or skip to a later phase. Wait for the prerequisite or report the blocker.
- An empty issue queue does not mean a phase is complete. Verify the milestone's completion criteria against the implementation; if criteria remain unmet, create issues for that remaining in-scope work.
- Do not create issues for later phases during queue bootstrap. Incidental or out-of-scope findings remain separate and deferred.

## Commits and push

- Use `type(scope): Summary` for every commit. Allowed types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Use the same `type(scope): Summary` format for pull request titles.
- CI validates the pull request title, branch name, and every commit subject. Fix any validation failure before requesting merge.
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

## Issue labels

Apply exactly one work-type label to each issue:

| Label | Color | Use |
| --- | --- | --- |
| `bug` | `#D73A4A` | Report of a defect |
| `feature` | `#1F883D` | Request for new functionality |
| `fix` | `#FBCA04` | Implementation work resolving a confirmed defect |
| `refactor` | `#8250DF` | Internal restructuring without intended behavior change |
| `task` | `#59636E` | Planned non-feature work that is not defect resolution, refactoring, or documentation-only work |
| `documentation` | `#0969DA` | Documentation-only work |

Apply one priority label after triage:

| Label | Color | Use |
| --- | --- | --- |
| `priority: critical` | `#B60205` | Security/data-loss or release-blocking failure |
| `priority: high` | `#D93F0B` | Core MVP flow blocked |
| `priority: medium` | `#FBCA04` | Normal planned work |
| `priority: low` | `#1F883D` | Polish or optional improvement |

Use these additional labels as needed:

| Label | Color | Use |
| --- | --- | --- |
| `status: blocked` | `#6E7781` | Only while progress depends on an external decision or prerequisite; remove when unblocked |
| `help wanted` | `#008672` | Invite contributors |
| `good first issue` | `#7057FF` | Guide newcomers |
| `duplicate` | `#CFD3D7` | Triage duplicate issues |
| `wontfix` | `#6E7781` | Triage work that will not be done |
| `accessibility` | `#F143AB` | Add alongside a work-type label when relevant |

Apply `accessibility` alongside exactly one work-type label when relevant. Apply contribution and triage labels in addition to the work-type label as appropriate.

## Milestone scope

Implementation issues must belong to exactly one SPEC roadmap milestone:

1. `Phase 1: Project Foundation`
2. `Phase 2: Markdown Storage Engine`
3. `Phase 3: AI Knowledge Builder`
4. `Phase 4: Retrieval Engine`
5. `Phase 5: MCP Integration`
6. `Phase 6: TUI`
7. `Phase 7: Advanced AI Features`
8. `Phase 8: Extended MCP & Operations`
9. `Phase 9: Distribution`

Assign an issue only to the phase whose listed SPEC work and completion criteria it directly advances. Before implementation, confirm every planned step fits the issue and its milestone. Do not add adjacent cleanup, future-phase work, or ideas from the post-v1 expansion roadmap (SPEC section 28) to the current task. Record incidental findings as separate issues and leave them out of the current implementation. If no milestone clearly fits, leave the issue unassigned and defer it for triage instead of expanding a milestone's scope.

## Review, pull request, and CI

1. When implementation is complete, ask a sub-agent to review the branch diff. Address actionable findings in new commits whose messages describe the code change, then push them.
2. Open a pull request to the repository's default branch and link the issue.
3. If CI checks are configured, watch them until they finish. For failures, inspect the logs, fix the cause, commit and push the fix, then wait for the checks again.
4. Merge the pull request only after review is complete and all configured CI checks pass. If no CI is configured, record that in the pull request and use the issue's acceptance criteria as the completion gate.

## Repository notes

- This project is local-first. Preserve user data and Markdown source documents when changing storage or update behavior.
- The repository may not yet contain runnable application code or CI checks. Inspect the available project scripts before choosing verification commands; do not claim checks ran when they did not.
