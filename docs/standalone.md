# Standalone builds

The CI standalone artifacts bundle the Node.js runtime, the `qlm` launcher, the
application, and its production dependencies for Windows, macOS, and Linux.
They run without a separately installed Node.js runtime. Each artifact is
specific to the operating system and CPU architecture that built it.

Extract the artifact and run `qlm --help` (on Windows, `qlm.cmd --help`). Keep
the files together: the launcher uses the bundled runtime and dependencies.
Project data remains in the normal QLM data directory; back it up before
removing the extracted application directory. For upgrades, extract a new
artifact separately and keep the existing project data directory.

CI artifacts are for verification and expire after 14 days. They are not
official releases; use the versioned GitHub Release once one is published.
