# Quick LLM Memory 0.1.0

Quick LLM Memory is a local-first knowledge manager that organizes Markdown
documents into a searchable hierarchy and provides a CLI, terminal interface,
and read-only MCP server tools.

## Install

Install the npm package with Node.js 24.11.0 or later in the 24.x line, or
Node.js 26 or later:

```sh
npm install -g quick-llm-memory
qlm --help
```

Standalone archives are provided for Linux, macOS, and Windows. Extract the
archive and run `qlm --help` (Windows: `qlm.cmd --help`). Keep the extracted
application files together. Project data is stored separately in the normal
QLM data directory.

Use `qlm init <name>` to create a project. See the packaged `docs/` directory
for the user guide, MCP configuration, and release verification details.

## Integrity

`SHA256SUMS` contains SHA-256 checksums for every attached npm and standalone
artifact. Verify an archive with `sha256sum -c SHA256SUMS` on systems with
sha256sum; Windows users can use `Get-FileHash -Algorithm SHA256 <file>` and
compare the result with the matching line.

This release was built from the matching version tag after the complete
Windows/macOS/Linux and Node.js test matrix, npm installation smoke, and
standalone startup smoke passed.
