# Retrieval quality checks

Run the deterministic Phase 4 fixture suite with:

```sh
npm run test:retrieval-quality
```

The local fixture covers exact-path and category retrieval, full-text relevance
and tag matching, ranked repeatable results, related-document provenance, and
token-bounded context. Expected results include the ordered hierarchy paths
`security/access.md`, `security/overview.md`; the full-text paths
`reference/firewall.md`, `security/overview.md`; and the tag match
`reference/firewall.md`. It instruments the validated Markdown reader during a
path-scoped context request and verifies that only the selected document is
read (twice: once to validate the search result and once to assemble context),
even when the fixture has many unrelated documents. With a 150-token budget,
the category query selects `security/access.md` and omits
`security/overview.md`, while staying within budget. The suite uses temporary
local files and SQLite only; it makes no provider requests and has no timing
thresholds.
