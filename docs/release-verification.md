# Release verification

Before publishing, run the complete configured gate from a clean checkout:

1. `npm ci`
2. `npm run build`
3. `npm test -- --maxWorkers=2`
4. `npm run typecheck`
5. `node scripts/smoke-npm-package.mjs`
6. `npm prune --omit=dev`
7. `npm run package:standalone -- standalone`
8. `node scripts/smoke-standalone.mjs`

GitHub Actions enforces the first five steps on Node 24.11.0 and Node 26 across
Windows, macOS, and Linux. The standalone workflow packages and smoke-tests
one artifact per operating system on Node 26. The npm tarball smoke installs
the packed artifact into a clean temporary consumer, starts the CLI, creates a
project, and lists it. The standalone smoke checks its local SQLite and native
no-replace helper. Both smokes use temporary data roots and delete them on
completion.

The npm package's native install step compiles the no-replace helper from the
included source. The standalone packaging workflow instead copies the helper
already built by `npm ci`. A release is ready only when all test-matrix,
packaging, and commit-validation checks pass. CI standalone artifacts expire
after 14 days and are verification outputs, not releases.

The first published release is `v0.1.0`, matching `package.json`. The Release
workflow accepts only an existing matching version tag, runs the same gates,
then assembles a curated npm tarball and three OS-specific standalone archives.
Dispatch it with `draft: true`, download and verify every artifact using
`SHA256SUMS`, run the documented CLI smoke checks, and publish the validated
draft from GitHub. Use the same draft-first process for later versions.
