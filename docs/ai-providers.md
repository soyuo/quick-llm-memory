# AI providers

Set `ai.provider` in `config.yaml` or choose it in TUI Settings and the build wizard.

| Provider | Credential | Notes |
| --- | --- | --- |
| `openai` / `openai-compatible` | `OPENAI_API_KEY` (and optional `OPENAI_BASE_URL`) | Supports embeddings. |
| `codex-cli` | ChatGPT subscription via the installed `codex` CLI | Runs `codex exec` read-only in a temporary directory. |
| `claude-code` | Anthropic account via the installed `claude` CLI | Runs `claude -p` with built-in tools disabled. |

## Subscription login

```bash
qlm auth login codex        # browser redirect; add --device on headless machines
qlm auth login claude
qlm auth status             # shows both
qlm auth logout codex
```

`qlm auth` delegates to the vendor CLIs, which run the browser redirect flow and keep the tokens. qlm never reads or stores subscription credentials. Install the `codex` and `claude` CLIs and make sure they are on `PATH`.

## Limits

- `codex-cli` and `claude-code` do not provide embeddings. Semantic search and embedding reindex still need `ai.provider: openai` with an API key; lexical and hybrid-lexical modes work without it.
- Each generation starts a CLI process, so builds are slower than direct API calls.
- Prompts are sent on stdin; model names are restricted to letters, digits, `.`, `:`, `_`, and `-`.
