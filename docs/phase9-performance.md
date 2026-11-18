# Phase 9 performance baseline

## Method

Run `npm run benchmark:phase9` on a machine with the project dependencies installed. The command builds the CLI, creates an isolated temporary `QLM_HOME`, generates 250 deterministic Markdown documents (1,401,000 body bytes total), and measures separate CLI processes for `--version`, `reindex --no-embeddings`, and a full-text search capped at 10 results. Each operation runs seven times; the first measured invocation is reported separately and the median of the remaining six is reported as warm. The OS filesystem cache is not flushed, so “first run” is not a claim of a cold machine or cold disk.

The fixture and query are local and deterministic. Reindex explicitly disables embeddings; no provider credentials are needed. The search asserts benchmark documents are returned. The script also captures a Node CPU profile of one indexing invocation and reports its highest sampled functions.

## Baseline

Captured 2026-11-18 on Windows 11 x64, Node v24.22.1, Intel Core Ultra 7 255H, 16 logical CPUs. Fixture: 250 documents, 5,604-byte body template per document, generated in one category. Build used the checked-in tsup configuration (`node24`).

| Run | Workflow | First invocation | Warm median (6 runs) |
| --- | --- | ---: | ---: |
| Baseline | CLI startup (`--version`) | 1,468 ms | 1,159 ms |
| Baseline | Index (`reindex --no-embeddings`) | 2,645 ms | 2,535 ms |
| Baseline | Full-text retrieval (top 10) | 1,352 ms | 1,192 ms |
| Final, no runtime changes | CLI startup (`--version`) | 3,322 ms | 1,073 ms |
| Final, no runtime changes | Index (`reindex --no-embeddings`) | 4,171 ms | 2,594 ms |
| Final, no runtime changes | Full-text retrieval (top 10) | 1,767 ms | 1,343 ms |

All seven retrieval runs returned matching fixture documents. The CPU profile's leading sampled functions were `lstat` (456 ticks), `internalModuleStat` (210), `compileSourceTextModule` (164), and Markdown parser functions (`subtokenize` 66, `subcontent` 60, `chunkInside` 53). This identifies filesystem validation and module loading as areas to investigate, but does not isolate their wall-clock contribution. The measured end-to-end values also vary substantially between repetitions, consistent with process launch and host load contributing to these short workflows.

The final run used the same script, fixture, machine, and runtime after adding the benchmark and documentation. Its CPU profile again showed the same leading areas (`lstat` 657 ticks, `internalModuleStat` 262, and `compileSourceTextModule` 159); the variation in timings and profile samples reinforces that this evidence does not justify changing runtime behavior in this issue.

## Optimization decision

No runtime optimization was made. The profile does not establish that removing or weakening path checks is acceptable, and it does not separate module startup, filesystem work, and SQLite work sufficiently to justify a safe targeted change. The benchmark and profile are retained so follow-up measurements can compare on the same fixture and machine. These results are a single-host baseline, not a cross-platform performance claim.
