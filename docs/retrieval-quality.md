# Retrieval quality checks

Run the deterministic retrieval fixture suites independently from the full test suite:

```sh
npm run test:retrieval-quality
```

## Phase 4 fixture baseline

The Phase 4 fixture covers exact-path and category retrieval, full-text relevance
and tag matching, ranked repeatable results, related-document provenance, and
token-bounded context. Expected results include the ordered hierarchy paths
`security/access.md`, `security/overview.md`; the full-text paths
`reference/firewall.md`, `security/overview.md`; and the tag match
`reference/firewall.md`. It instruments the validated Markdown reader during a
path-scoped context request and verifies that only the selected document is
read (twice: once to validate the search result and once to assemble context),
even when the fixture has many unrelated documents. With a 150-token budget,
the category query selects `security/access.md` and omits
`security/overview.md`, while staying within budget. It uses temporary local
files and SQLite only; it makes no provider requests and has no timing
thresholds.

## Phase 7 fixture baseline

The Phase 7 fixture contains three labeled Markdown documents. The firewall and
router documents are relevant to `network`; the firewall document is relevant
to the synonym query `prevent illicit entry`. The rose-care document is a
negative example. A local fake embedding provider assigns fixed vectors, so the
evaluation does not read credentials or access the network.

Baseline for the top two results:

| Query | Mode | Expected top results | Relevant coverage |
| --- | --- | --- | --- |
| `network` | Full-text | `network/router.md`, `network/firewall.md` | 2/2 (100%) |
| `network` | Semantic | `network/firewall.md`, `network/router.md` | 2/2 (100%) |
| `network` | Hybrid | `network/firewall.md`, `network/router.md` | 2/2 (100%) |
| `prevent illicit entry` | Full-text | No match | 0/1 (0%) |
| `prevent illicit entry` | Semantic | `network/firewall.md` | 1/1 (100%) |
| `prevent illicit entry` | Hybrid | `network/firewall.md` | 1/1 (100%) |

The `network` query deliberately gives full-text and semantic search different
first-ranked documents. Hybrid combines ranked sources through the production
reciprocal-rank fusion path; the test asserts its stable order and repeats
semantic and hybrid searches to check determinism. The synonym query confirms
semantic and hybrid retrieval can find a relevant document when full-text has
no match. This is a small regression baseline, not an external-model or
performance benchmark.
