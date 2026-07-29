# Local patch ledger

This fork is based on upstream commit `e0d7979b4f0d9fd4ea547bd8cd8bfb4ee9be78fb` (`v0.1.10`).

Purpose: describe the local behavior delta on top of upstream so future syncs can distinguish intentional fork behavior from accidental drift.

## Session cleanup flow

Local `bin/pisesh` adds an `X` cleanup action for the selected historical session.

The cleanup flow adds these behaviors:

- opens a preview screen before deletion;
- requires typing `DELETE` before cleanup runs;
- blocks cleanup for the attached `[NOW]` session;
- deletes only known associated pisesh/Pi artifacts;
- prefers system trash (`trash`, `trash-put`, or `gio trash`) before direct deletion;
- removes the matching favorite after the session file is removed.

`lib/cleanup.js` contains the cleanup planning and execution logic. It only includes allowlisted paths and rejects unsafe symlink/path escapes.

## Associated artifact discovery

Local cleanup includes known associated artifacts, not arbitrary files mentioned in a conversation.

The allowlisted artifact set includes:

- the selected session JSONL;
- that session's pisesh favorite entry;
- matching Pi/Slipstream compaction artifacts under known compaction roots;
- Slipstream per-session stats JSONL;
- sibling subagent child-session trees stored next to the parent session file;
- exact subagent async-run directories parsed from the session file when they are under known `pi-subagents` temp roots.

## Vendored `/sesh` launcher

Local `extensions/sesh.ts` launches the package-local `bin/pisesh` through `process.execPath` instead of resolving `pisesh` from `$PATH`.

The slash command forwards:

- `PISESH_CURRENT_SESSION`, from the active Pi session id;
- `PISESH_CWD`, from the slash command context cwd;
- inherited stdio inside Pi's custom UI lifecycle.

The command fails closed when the current Pi session id is unavailable.

## Current-session and resume semantics

Local resume behavior differs from upstream in these ways:

- selecting the attached `[NOW]` session exits back to the current Pi instead of spawning nested Pi;
- selecting another session resumes with `pi --session <session-file> --session-dir <session-dir>`;
- resume cwd falls back from the session's recorded cwd to forwarded `PISESH_CWD`, then process cwd, then the session directory root;
- cwd fallback tolerates inaccessible process cwd.

The upstream `v0.1.10` orphan-tool-call healer remains upstream behavior, not a local delta.

## Package and test layout

Local package metadata ships and tests the added cleanup/extension behavior:

- `package.json` includes `lib/` in published files;
- `package.json` expands `npm test` to syntax-check `bin/pisesh` and `lib/cleanup.js`, then run current-session, cleanup, and extension-load tests;
- `jiti` is a dev dependency for loading the TypeScript extension in tests;
- `pnpm-workspace.yaml` sets `lockfile: false` so local package test runs do not create a submodule lockfile.

## Validation used for this patch stack

Commands run from `packages/pisesh`:

```sh
pnpm test
env -u PISESH_CWD pnpm test
```

The second command is only useful when testing the fallback path from an environment that already exports `PISESH_CWD`; the local tests now delete that inherited variable for the relevant case.
