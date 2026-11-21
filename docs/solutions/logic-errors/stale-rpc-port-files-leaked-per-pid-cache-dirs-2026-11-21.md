---
title: Stale RPC port files leaked one cache directory per dead OpenCode process
date: 2026-11-21
category: logic-errors
module: opencode_runtime
problem_type: logic_error
component: tooling
symptoms:
  - "About 1,522 per-PID directories accumulated under `~/.cache/opencode/copilot-delegate/`, each holding a `server-port.json` with a dead port and its bearer token"
  - "A host that exited without `beforeExit`/SIGTERM (SIGKILL, crash, torn-down worker) always left its port file behind"
  - "After the first sweep, clean exits still left empty `<pid>/` directories that the sweep never removed and that used up its 256-entry cap"
root_cause: scope_issue
resolution_type: code_fix
severity: medium
related_components:
  - testing_framework
tags: [rpc, port-file, stale-cleanup, pid-liveness, bearer-token, fail-closed, xdg-cache, file-leak]
---

# Stale RPC port files leaked one cache directory per dead OpenCode process

## Problem

Each server writes `<XDG_CACHE_HOME or ~/.cache>/opencode/copilot-delegate/<discriminator>/server-port.json` (`defaultPortFileBaseDir` in `src/runtime/rpc-paths.ts`). Cleanup only ever touched the current discriminator's directory. The discriminator is normally the PID and never repeats, so every unclean exit left a directory, and a bearer token, that nothing would revisit (#573).

## Symptoms

- 1,522 directories dated May–Oct 2026 in the real cache.
- Each of the three 1.19.6 live-check sessions for #568 and #572 left its file behind.
- With the first sweep version, 1,000 seeded empty directories meant only 5 of 10 dead port files were reached.

## What Didn't Work

- **`removeStalePortFiles` in `src/runtime/rpc-server.ts`.** It deletes only `server-port.json` and `server-port.json.tmp.*` inside the *current* `portFileDir`. That is correct for a restart under the same discriminator and useless for PID-keyed siblings.
- **Relying on `close()`.** It runs only through `wireRpcServerCleanup` (`src/lib/rpc-cleanup.ts`) on `beforeExit`/SIGTERM.
- **First sweep (commit 0920e87).** It removed dead `server-port.json` files but skipped directories with no port file. `close()` at the time removed only the file, so every clean exit produced an empty directory that occupied a sweep slot on every start. Fixed in commit 771ab49; both were squashed into 80f669c.
- **The `orphan-reaper` comm/lstart identity gate (`getPidIdentity`).** The port file records no process start time, so there is nothing to compare against. Only liveness is used.

## Solution

`src/runtime/rpc-port-sweep.ts` (`sweepStalePortFiles`) runs from `startRpcServer` only after the server is listening and its own port file is published. A yield in `runStaleSweep` keeps it off the init path:

```ts
await writePortFile(portFilePath, port, token)
portFileWritten = true

// Sweep sibling directories only after the server is up and its own port
// file is published, off the init critical path, and never rejecting.
const sweepPromise = runStaleSweep(options, portFileBaseDir, sessionDiscriminator)
```

`close()` awaits `staleSweep` so shutdown never races the sweep. The sweep never rejects: per-entry errors count as `kept`, and an unreadable base directory returns zeros.

**Per-entry rules (`sweepEntry`):**

- Skip the current discriminator, and examine at most `DEFAULT_PORT_SWEEP_MAX_ENTRIES = 256` entries per start.
- `lstat` the directory and the file, without following symlinks. The directory must be a real directory and the file a regular file.
- An empty directory past the grace window is removed with a non-recursive `rmdir`, so a leftover temp file keeps it.
- The file's mtime must be older than `DEFAULT_PORT_FILE_GRACE_MS` (10 minutes).
- `decidePid` reads only `pid` from the parsed JSON, never the token. If `pid` is missing, it falls back to an all-digit directory name. Garbage, a non-object, an invalid `pid`, or a numeric directory that disagrees with the recorded `pid` counts as `ambiguous` and is kept.
- `defaultIsPluginAlive` (`src/runtime/orphan-reaper.ts`) uses `process.kill(pid, 0)`, and EPERM counts as alive.
- Removal deletes the file, then runs a non-recursive `rmdir`:

```ts
if (isPidAlive(decision.pid)) return false

await rm(filePath, { force: true })
// Non-recursive: only succeeds when the directory is now empty.
await rmdir(dirPath).catch(() => {})
return true
```

`close()` now also drops its own emptied directory through `removePortFile`. Logging is a count only, emitted only when `removed > 0`:

```ts
`[copilot-delegate] removed ${result.removed} stale RPC port file(s) from exited sessions`
```

**Tests and live check:**

- `tests/rpc-port-sweep.test.ts` uses real temp directories with an injected `now` and liveness probe. It covers dead and live PIDs, the grace window, PID/directory mismatch, garbage JSON, symlinks, the cap, empty directories, and a `close()` that removes its own directory.
- Live check on `opencode serve` 1.19.6:
  - 303 → 50 directories on the first start (254 removed under the cap);
  - a live sibling was kept;
  - a `kill -9`'d instance was removed on the next start;
  - no tokens appeared in the logs;
  - the first request returned in 0.13–0.26 s with 1,015 entries;
  - against the real cache, one start logged `removed 255 stale RPC port file(s) from exited sessions`, taking it from 1,528 to 1,274 entries (recorded in the PR #578 body).

## Why This Works

The leak was a scope error: cleanup was scoped to "my directory", but the files belonged to dead processes. The sweep widens the scope to siblings and makes every deletion conditional on positive evidence of staleness: age, an identified writer, and that writer being dead. Ambiguity fails closed, so the worst case is a leftover file, never a live server losing TUI discovery. The cap and the async start drain a large backlog over several starts without blocking init. Removing empty directories keeps cap slots for real work.

The sweep assumes nothing about discriminators beyond "all digits may be a PID", which is why it survived the V2 change to server-PID discriminators (#587).

## Prevention

- Any per-process artifact keyed by a non-repeating ID needs a sibling sweep. Exit hooks alone don't run on SIGKILL or crash.
- Gate deletion on a liveness check that fails closed. Treat EPERM as alive.
- Read only the fields you need from files that carry secrets, and log counts, not paths or tokens.
- Use `lstat` and non-recursive `rmdir` for cleanup in shared cache directories.
- Cap per-start work and keep it off the init path. Make sure empty or ambiguous leftovers can't permanently consume the cap.
- Known accepted limits: a reused PID keeps its file, ambiguous entries still take slots, and order follows `readdir`, not age.

## Related Issues

- Issue #573; PR #575 (commits 0920e87 and 771ab49, squashed to 80f669c).
- PR #578 (records the real-cache sweep result).
- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md` (the exact-file startup cleanup rule).
- `docs/solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md`
