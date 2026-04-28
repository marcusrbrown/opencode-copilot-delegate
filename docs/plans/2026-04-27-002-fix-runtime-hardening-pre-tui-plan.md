---
title: "fix: pre-TUI runtime hardening (orphan reaper + cancel-race parser guard)"
type: fix
status: active
date: 2026-04-27
deepened: 2026-04-27
origin: docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md
target_release: v0.1.1
follow_up_plan: docs/plans/2026-04-27-001-feat-copilot-status-tui-foundation-plan.md
---

# fix: pre-TUI runtime hardening (orphan reaper + cancel-race parser guard)

## Overview

Two existing-runtime correctness fixes that ship as a v0.1.1 patch ahead of the v0.2.0 TUI foundation:

1. **PID-file orphan reaper** — closes the case where Copilot subprocesses survive plugin reload because the OpenCode `Hooks` interface has no dispose hook. Server reads a PID file at init time and reaps any survivors before resuming normal operation.
2. **Parser cancel-race guard** — closes a real bug in the existing JSONL stdout handler that allows post-cancel events to mutate the task registry. The fix is a single-line guard at the top of the inline data handler.

Both are correctness fixes, not features. They surfaced during planning for the v0.2.0 TUI work but are independent of the TUI architecture and worth shipping on their own. Splitting them out keeps the v0.2.0 PR focused on TUI scope and gives each fix a clean review/merge cycle.

## Problem Frame

**Orphan reaper**: When OpenCode reloads the plugin (e.g., on config change, plugin update, or session restart), in-flight `copilot` subprocesses do not receive any cleanup signal because the server-side `Hooks` interface exposes no dispose hook. Subprocesses orphan and continue running until they complete naturally or the user notices and kills them manually. There is no automated recovery.

**Cancel-race parser guard**: When `copilot_cancel` is invoked, `task.abortController.abort()` synchronously sets `task.status = 'cancelled'` and asynchronously kills the subprocess. Between the kill signal and the actual stream close, the child process's stdout buffer may still contain unread JSONL lines. The current inline data handler in `src/runtime/subprocess.ts` (an anonymous `child.stdout?.on('data', ...)` callback inside `spawnCopilot`) does not check `task.status` before pushing parsed events onto `task.events`. Result: events from a cancelled task continue to accumulate in the registry until the stream actually closes — observable as `copilot_output cpl_xxx` returning events recorded after the cancel timestamp.

Both bugs predate the v0.2.0 TUI work. They were identified during planning for that plan but neither requires the TUI architecture to fix.

## Requirements Trace

- **R1** (orphan reaper) — On plugin init, read the PID file at `<XDG_STATE_HOME or ~/.local/state>/opencode-copilot-delegate/orphans.pids`. For each entry: probe liveness (`process.kill(pid, 0)`), compare recorded start time against live `ps -p <pid> -o lstart=` output, and `killProcessTree(pid)` only when the live process is the same one originally tracked. Persist append on task spawn; persist remove on terminal transition. (origin: `docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md` §"Prerequisites for ce:plan" #3)
- **R2** (parser guard) — In the `child.stdout?.on('data', ...)` callback inside `spawnCopilot`, skip event-push and registry mutation when `task.status !== 'running'`. The single-threaded JS execution model means the guard at the top of the line-loop closes the race for all subsequent events in this and future `data` ticks. (origin: planning pass on the v0.2.0 plan; see commentary in the v0.2.0 follow-up plan's deferred-tasks section)

## Scope Boundaries

- **No new public API surface.** PID file path is internal. Parser guard is invisible to consumers.
- **No changes to existing tool inputs or outputs.** `copilot_delegate`, `copilot_output`, `copilot_cancel` keep their current shapes.
- **No RPC server, no TUI, no slash commands.** Those are v0.2.0.
- **No new dependencies.** `node:fs`, `node:child_process`, `node:os` only.
- **No Windows support beyond what's already there.** The reaper uses POSIX `process.kill(pid, 0)` and the `ps` shell-out, both Unix-only — same constraint as the existing `kill-tree.ts`.

### Deferred to Separate Tasks

- **Upstream lifecycle-hook feature request to `anomalyco/opencode`** — file alongside this v0.1.1 PR with a code TODO pointing at the issue. The reaper retires when upstream lands a dispose hook.

## Context & Research

### Relevant Code and Patterns

- `src/runtime/subprocess.ts` — `spawnCopilot` function. The `child.stdout?.on('data', ...)` callback is an inline anonymous function (no `parseStream` named function exists). Status mutation happens in three places: `finalizeTask` (sets `complete`/`failed`), the abort-signal listener (sets `cancelled`), and `child.once('error', ...)` (sets `failed`). The parser guard goes at the top of the inline data handler's `for (const line of lines)` loop.
- `src/runtime/task-registry.ts` — `taskRegistry`. `createTask` and the abort/finalize paths are where the PID file's `appendPidEntry` and `removePidEntry` calls hook in.
- `src/lib/kill-tree.ts` — `killProcessTree` reused unchanged.
- `src/runtime/envelope.ts` — `TaskState` shape; status field exists via `SpawnCopilotResult.status: TaskStatus`.

### Institutional Learnings

- `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md` — relevant if reaper smoke-testing requires `--print-logs --log-level DEBUG`.

## Key Technical Decisions

- **PID file location (per-instance, keyed on plugin process PID)**: `<XDG_STATE_HOME or ~/.local/state>/opencode-copilot-delegate/orphans/<plugin-pid>.pids`, where `<plugin-pid>` is `String(process.pid)` (the plugin host process PID at startup). v0.1.1 deliberately keys on PID rather than `OPENCODE_SESSION_ID` because the reaper needs a directly **probeable spawner-liveness signal** at scan time — see the spawner-liveness gate below. Two concurrent OpenCode sessions each load the plugin in their own host process and naturally get different PIDs, so per-instance isolation is preserved without requiring session env vars. (v0.2.0's port file uses `OPENCODE_SESSION_ID` because its consumer needs session-aware lookup, not liveness probing — different requirement, different key.) Plain text, line-delimited, format `<pid>\t<comm>\t<lstart>` (tab-separated; the `comm` value is the kernel-tracked executable name from `ps -o comm=` and is the kill-gate identity check). Parent directory `<state-dir>/orphans/` created with `0o700`; per-instance files created with `0o600`. **Per-instance keying eliminates the cross-instance file-clobbering risk** that a single shared `orphans.pids` file would create — concurrent OpenCode sessions each read/write/truncate only their own file.
- **Start-time source for the recorded value**: at task spawn, immediately invoke `ps -p <pid> -o lstart=` (array-spawn, no shell) and store the returned string verbatim alongside `comm`. This guarantees the recorded value matches the format `ps` will return at reap time. (Do **not** use `task.startedAt` epoch ms — `ps` and `Date.now()` produce incomparable strings.)
- **`ps` invocation**: `child_process.spawn('ps', ['-p', String(pid), '-o', '<field>='])` with no shell, where `<field>` is `lstart`, `comm`, or (for diagnostic logging) `args`. Eliminates command-injection risk if the PID file is malformed.
- **PID file write strategy**: `node:fs` `O_EXCL` temp-file + atomic `rename` for both append and remove. No new dep. **Per-instance keying means single-writer per file** — there is no cross-instance contention, and within an instance a process-local serialization queue (a `Promise` chain in `pid-file.ts`) orders concurrent appends/removes from the existing `MAX_CONCURRENT = 10` task lifecycle without needing a `proper-lockfile`-style cross-process lock. The combination guarantees no lost appends, no torn writes, and idempotent removal. The flag constant lives in `fs.constants.O_EXCL` (not `os.constants`).
- **PID-validate-before-kill (executable identity, exact `comm` match)**: Before invoking `killProcessTree(pid)`, validate that the process's kernel-tracked executable name from `ps -p <pid> -o comm=` (array-spawn, exact-string compare) matches the `<comm>` value recorded at spawn time. `comm` returns the binary name only — no arguments, no full path — which closes the false-positive class where a process's `args` happens to contain the substring `copilot` (e.g., `cat /tmp/copilot-output.log`, a manually-invoked GitHub Copilot CLI command running on the same host, or a shell script with `copilot` in its path or argv). Combined with the start-time match, the kill gate requires (live PID = recorded PID) AND (live comm = recorded comm) AND (live lstart = recorded lstart) — collisions are statistically impossible without deliberate forging, and forging requires write access to a 0o600 PID file inside a 0o700 directory.
- **Reap sequencing (awaited)**: Reap runs **awaited** inside the plugin factory, before the factory returns its `Hooks` object. The SDK's `Plugin = (input) => MaybePromise<Hooks>` contract guarantees the host won't dispatch tools until the factory resolves, so a same-instance "tool-call-before-reap-finishes" race cannot occur. v0.2.0's RPC server starts after this completes; v0.1.1 has no RPC server. **Implementation note**: wrap the reap call in try/catch — reap failure must never block plugin init.
- **Reap latency budget (parallel probes)**: At `MAX_CONCURRENT = 10` historical entries across all `<state-dir>/orphans/*.pids` files, naive sequential per-PID `ps` shellouts could take 0.5-3s — unacceptable for plugin init. Reap probes run **in parallel with a small concurrency cap** (`Promise.all` over up to 5 simultaneous workers; each worker handles its assigned PIDs sequentially: liveness probe → `comm` check → `lstart` check → optional `killProcessTree`). Soft target: total reap time under 200ms at full cap on a typical macOS dev host. Verified by Unit 2's smoke test.
- **Reap directory scan + spawner-liveness gate**: Reaper scans **all `*.pids` files** in `<state-dir>/orphans/` so survivors from previous plugin instances are recovered. For each foreign file (filename PID ≠ our `process.pid`), the reaper extracts the owning plugin's PID from the filename and probes `process.kill(<plugin-pid>, 0)`:
  - **Alive** (call succeeds) or **`EPERM`** (process exists but we lack signal permission — still counts as alive): skip the entire file. The owning plugin is still tracking those subprocesses; killing them would break a running session. The identity gate alone is insufficient for foreign files: a live foreign instance's subprocesses would pass the `comm`+`lstart` gate (they ARE legitimate copilot subprocesses) and be wrongly killed.
  - **Dead** (`ESRCH`): proceed with per-entry reap. After processing, **delete the file** — the owning plugin is gone, and bounded directory growth is the desirable hygiene property here.
  - **Current instance's own file** (filename matches `String(process.pid)`): processed unconditionally; truncated/recreated post-reap. We know our own plugin is alive; we want to clean entries from subprocesses that died while the plugin was loaded but before reap fired.
- **Parser guard placement**: In `spawnCopilot`, at the top of the existing inline `child.stdout?.on('data', (chunk: string) => { ... })` handler. Inside the `for (const line of lines)` loop, the guard goes **before** `parseJsonlLine(line)` (not before `events.push(event)`) so a cancelled task does not pay the parse cost on already-buffered lines: `if (task.status !== 'running') break;`. The partial-line buffer update (`lines.pop()`) runs *before* the loop, so `break` and `return` would behave identically here — `break` is preferred for clarity. Single-threaded JS guarantees the guard is checked synchronously with every iteration, with no interleaving possible.
- **Status-mutation refactor (terminal-state-preserving)**: The current `src/runtime/subprocess.ts` mutates `task.status` inline at three sites — line 59 (`finalizeTask`, on subprocess `close` event), line 143 (abort listener), and line 153 (spawn `error` event). v0.1.1 introduces a `setStatus(task, newStatus, options?)` helper that wraps the assignment and the `removePidEntry` cleanup as a single atomic-from-the-caller's-perspective operation. **The helper is idempotent on terminal state**: if `task.status` is already terminal (`complete | failed | cancelled`) and `newStatus` is also terminal, `setStatus` no-ops and returns. This preserves the existing `finalizeTask` invariant `if (task.status !== 'cancelled') task.status = ...` automatically: when the subprocess `close` event fires after the abort listener has already set `cancelled`, `setStatus(task, 'complete' | 'failed', ...)` is a no-op. Future contributors don't need to remember the guard. The three sites become `setStatus(task, 'complete' | 'failed' | 'cancelled', { pidFilePath })` calls. Centralizes lifecycle plumbing, prevents the cleanup hook from being forgotten, and gives Unit 4's parser guard a stable invariant to read.

## Open Questions

### Resolved During Planning

- **PID-file format**: tab-separated `<pid>\t<comm>\t<lstart>`. Captures both the kernel-tracked executable name and the start-time string from `ps`.
- **Start-time source**: live `ps` at spawn time, not `Date.now()`. Eliminates format mismatch.
- **`ps` shell vs array spawn**: array-spawn, no shell.
- **PID-validate-before-kill identity check**: exact `comm` match via `ps -p <pid> -o comm=`, not substring match on `args`. Closes the false-positive class where another process's argv happens to contain `copilot`.

### Resolved During Deepening Pass (2026-04-27)

- **Per-instance PID files vs single shared file**: shared `orphans.pids` was a real cross-instance integrity hole (one OpenCode session's end-of-reap truncate could wipe a live PID written by another session). Resolved to per-instance files at `<state-dir>/orphans/<plugin-pid>.pids`. The reaper scans the whole directory.
- **Discriminator choice (PID, not session ID)**: keying the v0.1.1 PID file on `process.pid` rather than `OPENCODE_SESSION_ID` is intentional — the reaper needs spawner-liveness probing, and PID is directly probeable via `process.kill(pid, 0)` whereas session IDs are not. v0.2.0's port file keys on session ID for a different reason (consumer-side session lookup).
- **Spawner-liveness gate (foreign files)**: the identity gate alone (exact `comm` + `lstart` match) cannot distinguish "OUR live child" from "a live foreign instance's child whose recorded identity happens to match" — a foreign live instance's subprocesses would pass the gate and be wrongly killed. Resolved by adding a per-file spawner-liveness probe: alive foreign spawner → skip file entirely; dead foreign spawner → reap entries and delete the file. Side benefit: bounds directory growth without a separate cleanup policy.
- **Reap blocking init**: keeping reap awaited inside the factory is correct (the SDK contract guarantees no tool dispatch until the factory resolves). The acceptability concern is latency, not sequencing. Resolved by parallelizing per-PID probes with a concurrency cap of 5; soft 200ms target at full cap.
- **Status-mutation refactor (terminal-preserving)**: three inline sites in `subprocess.ts` (lines 59, 143, 153) become a single `setStatus` helper that no-ops when transitioning between terminal states. Preserves the existing `finalizeTask` `if (task.status !== 'cancelled')` invariant automatically; future contributors can't drop it accidentally.
- **Parallel reap probes**: `Promise.all` with concurrency cap of 5 (not unbounded) — bounded fan-out keeps the `ps` shellout cost predictable on hosts where individual `ps` calls are slow.

### Deferred to Implementation

- **`ps -p <pid> -o lstart=` portability across BSD vs GNU `ps`**: macOS BSD `ps` is verified by direct test during implementation. Linux GNU `ps` ships `lstart` in `procps-ng` (mainstream distros) but may differ on minimal images (Alpine `busybox ps`). Implementation-time gate: write a small smoke test asserting `ps -p $$ -o lstart=` returns a non-empty parseable value on the dev host; document the dependency in README and AGENTS.md.

## Output Structure

```
src/
├── runtime/
│   ├── orphan-reaper.ts           # Directory scan + spawner-liveness gate + parallel PID probes + comm/lstart identity gate
│   ├── pid-file.ts                # appendPidEntry, removePidEntry, per-instance path resolver (PID-keyed)
│   ├── subprocess.ts              # (modified) parser guard at top of inline data handler; 3 sites → setStatus calls
│   ├── task-status.ts             # NEW: setStatus(task, newStatus) helper — idempotent on terminal state + removePidEntry cleanup
│   └── task-registry.ts           # (modified) wire appendPidEntry on spawn; pass setStatus to subprocess wiring
└── index.ts                       # (modified) build per-instance pid file path; await reapOrphans before returning

tests/
├── orphan-reaper.test.ts          # Directory scan, spawner-liveness gate (alive/dead/EPERM), parallel probes with concurrency cap, comm-match identity gate, foreign-file deletion after dead-spawner reap
├── pid-file.test.ts               # Append, remove, in-process serialization queue, atomic rename, PID-keyed path resolution
├── task-status.test.ts            # NEW: setStatus terminal-state idempotency + removePidEntry cleanup hook
├── subprocess.test.ts             # (modified) cancel-race scenario; setStatus called from each of the 3 sites; finalizeTask cancel-guard interaction (close fires after abort → cancelled status preserved)
└── task-registry.test.ts          # (modified) PID-file hooks fire on spawn
```

## Implementation Units

- [x] **Unit 1: PID-file helpers (`pid-file.ts`)**

**Goal:** Atomic append + remove for the PID file.

**Requirements:** R1 (persistence layer for the reaper).

**Dependencies:** None.

**Files:**
- Create: `src/runtime/pid-file.ts`
- Create: `tests/pid-file.test.ts`

**Approach:**
- Export `appendPidEntry(filePath, pid, comm, startTimeString) → Promise<void>` and `removePidEntry(filePath, pid) → Promise<void>`. Also export `resolveInstancePidFilePath(): string` that builds `<state-dir>/orphans/<process.pid>.pids` (uses the host plugin's PID; deliberately not `OPENCODE_SESSION_ID` — see Key Decisions for the spawner-liveness rationale).
- Append: read existing content (or empty if missing), construct new content with the appended `<pid>\t<comm>\t<startTime>` tab-separated line, write to `<path>.tmp.<random>` with `fs.constants.O_EXCL | O_CREAT | O_WRONLY` and `mode: 0o600`, `fs.rename` to final path, `fs.chmod(path, 0o600)` for belt-and-braces.
- Remove: same flow, but compute new content by filtering out the matching `<pid>\t` prefix.
- **In-process serialization**: a module-private `Promise` chain serializes all writes to the same path. `appendPidEntry` and `removePidEntry` both await the previous chain link before performing their atomic-rename cycle. This eliminates lost-update races within a single OpenCode session at the existing `MAX_CONCURRENT = 10` cap. Cross-instance contention is structurally impossible under the per-instance file design.
- Ensure parent dir with `mkdir({ recursive: true, mode: 0o700 })`.
- Both functions tolerate a missing file: append creates it; remove is a no-op.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Happy path:* `appendPidEntry` to a fresh path → file exists with one tab-separated `<pid>\t<comm>\t<lstart>` line; mode is `0o600`; parent dir mode is `0o700`.
- *Happy path:* `appendPidEntry` 3 times sequentially → file has 3 lines in spawn order.
- *Happy path:* `removePidEntry(pid)` on a file with 3 entries removes only the matching one; remaining order preserved.
- *Edge case:* `appendPidEntry` to a non-existent parent dir → dir created with `0o700`; file written.
- *Edge case:* `removePidEntry` for a PID not in the file → no-op, no error.
- *Edge case:* `removePidEntry` on a missing file → no-op, no error.
- *Concurrency:* `appendPidEntry` invoked 10x concurrently → file ends with **exactly 10 entries**, all well-formed (the in-process `Promise`-chain serialization queue orders the writes so no append is lost). This is a stronger guarantee than the v0.1 plan's 1..N expectation — verified test scenario.
- *Path resolution:* `resolveInstancePidFilePath()` returns `<state-dir>/orphans/<process.pid>.pids` regardless of environment (plugin PID is the only key).
- *Mode:* After both append and remove, file mode remains `0o600`.

**Verification:** All scenarios pass; `bun run typecheck` + `bun run lint` clean.

---

- [x] **Unit 2: Orphan reaper (`orphan-reaper.ts`)**

**Goal:** Read the PID file at init time, reap survivors with PID-validate-before-kill.

**Requirements:** R1.

**Dependencies:** Unit 1.

**Files:**
- Create: `src/runtime/orphan-reaper.ts`
- Create: `tests/orphan-reaper.test.ts`

**Approach:**
- Export `reapOrphans({ pidFileDir, currentInstancePath, killProcessTree, getPidComm, getPidStartTime, isPluginAlive }) → Promise<{ reaped: number, skipped: number, scannedFiles: number, deletedFiles: number }>`. Inject all process-shellouts and the plugin-liveness probe for testability. Default `isPluginAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }`.
- `getPidComm(pid)`: `spawn('ps', ['-p', String(pid), '-o', 'comm='])` with no shell. Return trimmed stdout, or `null` on non-zero exit / process gone.
- `getPidStartTime(pid)`: `spawn('ps', ['-p', String(pid), '-o', 'lstart='])` with no shell. Return trimmed stdout, or `null`.
- **Directory scan**: `fs.readdir(pidFileDir)`; filter to `*.pids`. For each file:
  - Extract the owning plugin's PID from the filename stem (`<plugin-pid>.pids` → parse-int).
  - **If filename PID equals `process.pid`** (current instance's own file): proceed unconditionally to per-entry reap. Truncate the file post-reap.
  - **Else (foreign file)**: probe `isPluginAlive(<plugin-pid>)`.
    - **Alive**: skip the file entirely. Owning plugin is still tracking those subprocesses.
    - **Dead**: proceed to per-entry reap. **Delete the file** post-reap (bounded directory growth).
    - **Filename does not parse as a PID** (corrupted or unrelated): skip + log warning.
- For each file processed: parse `<pid>\t<comm>\t<lstart>` per line; ignore malformed lines.
- **Parallel per-PID probes** (`Promise.all` with concurrency cap of 5 via a small worker-pool helper): for each entry:
  1. Probe liveness: `process.kill(pid, 0)` inside try/catch. Throws → process gone, skip; entry will be cleaned up when the file is rewritten.
  2. Identity gate: `getPidComm(pid)` === recorded `comm` AND `getPidStartTime(pid)` === recorded `lstart`. Either mismatch → PID reused or unrelated process, skip + log warning.
  3. Kill: `killProcessTree(pid)` inside try/catch. Catch-all ensures one bad PID doesn't stop the loop.
- After processing each file:
  - **Current instance's own file** (`currentInstancePath`): truncate (the reaped PIDs are now dead; new entries will be re-appended by `appendPidEntry` on subsequent task spawns within this session).
  - **Other instances' files**: leave intact. They are owned by other plugin instances or by previous sessions whose plugin process exited without cleanup; the dead-PID entries inside them are harmless and will get cleaned the next time those discriminators reload.
- Aggregate `reaped` / `skipped` / `scannedFiles` counts; return.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Happy path:* Empty `pidFileDir` → `{ reaped: 0, skipped: 0, scannedFiles: 0, deletedFiles: 0 }`; no error.
- *Happy path:* Current instance's file with one alive PID whose live `comm` and `lstart` match recorded → `killProcessTree` called once; `{ reaped: 1, skipped: 0, scannedFiles: 1, deletedFiles: 0 }`; current-instance file truncated.
- *Happy path (foreign file, dead spawner):* `<dir>/<own-pid>.pids` (current, empty) + `<dir>/9999.pids` (foreign, plugin PID 9999 dead per `isPluginAlive`, 1 entry: alive matching child). Reap kills the orphaned child; foreign file is **deleted** post-reap; `{ reaped: 1, skipped: 0, scannedFiles: 2, deletedFiles: 1 }`.
- *Happy path (foreign file, live spawner):* `<dir>/<own-pid>.pids` + `<dir>/8888.pids` (foreign, plugin PID 8888 alive per `isPluginAlive`, 2 entries with live matching children). Reap **skips** the foreign file entirely; `killProcessTree` NOT called for those children; foreign file left intact; `{ reaped: 0, skipped: 0, scannedFiles: 2, deletedFiles: 0 }` (foreign-skip does not count as scanned-and-processed).
- *Edge case (foreign file, EPERM on probe):* `process.kill(<foreign-pid>, 0)` throws `EPERM` (process exists, we lack permission) → treated as alive; foreign file skipped.
- *Edge case (foreign filename non-numeric):* `<dir>/garbage.pids` → skipped + logged warning; not deleted, not processed.
- *Edge case (foreign file, dead spawner, all entries dead):* foreign file with 3 entries all `process.kill(pid, 0)` throwing → no kills; file deleted post-reap.
- *Edge case (foreign file, dead spawner, mismatched identity):* foreign file with alive PID whose `comm` differs → not killed (identity gate fail); skipped; file deleted (all entries processed, dead spawner).
- *Edge case (mixed):* current file (1 alive-match, 1 dead) + foreign-alive file (skipped) + foreign-dead file (1 alive-match killed) → `{ reaped: 2, skipped: 0, scannedFiles: 3, deletedFiles: 1 }`.
- *Edge case (PID dead):* `process.kill(pid, 0)` throws → not killed; counted as skipped; current file truncated post-reap.
- *Edge case (`comm` mismatch):* Alive PID, but live `comm` differs from recorded → not killed (PID reuse or unrelated process); skipped + warned.
- *Edge case (`lstart` mismatch):* Alive PID, matching `comm`, but live `lstart` differs from recorded → not killed (PID reuse); skipped + warned.
- *Edge case (`args` substring red herring):* Alive PID whose `args` *contains* `copilot` (e.g., `cat /tmp/copilot-output.log`) but whose `comm` is `cat`, not `copilot` → not killed (defends the false-positive class). Verified by spawning a stub process with a tailored `argv[0]`/comm distinction.
- *Concurrency:* 5 worker-pool cap respected: at 10 PIDs, no more than 5 concurrent `ps` shellouts in flight at any moment (assert via spy on the `ps` shellout counter).
- *Latency:* Total reap with 10 alive-but-skipped entries completes in under 200ms on the dev host (soft target; not a hard assertion).
- *Error path:* Malformed line → skipped silently; valid lines still processed.
- *Error path:* `killProcessTree` throws (injected) → caught, counted as skipped; loop continues across remaining entries.
- *Error path:* `getPidStartTime` returns `null` for an alive PID (race) → skipped, no kill.
- *Error path:* `fs.readdir(pidFileDir)` throws (dir missing) → returns `{ reaped: 0, skipped: 0, scannedFiles: 0 }`; no error propagation.

**Verification:** All scenarios pass; manual smoke on macOS dev host: spawn `sleep 60`, write its PID + recorded start time, simulate plugin re-init, confirm sleep is killed. Smoke on Linux dev host: same.

---

- [x] **Unit 3: `setStatus` helper + wire pid-file hooks into spawn + plugin-init reap**

**Goal:** Append on task spawn. Centralize the 3 inline status mutations through a new `setStatus` helper that also calls `removePidEntry`. Build the per-instance pid file path in `src/index.ts` and `await reapOrphans()` before returning Hooks.

**Requirements:** R1.

**Dependencies:** Units 1, 2.

**Files:**
- Create: `src/runtime/task-status.ts` (the `setStatus` helper)
- Create: `tests/task-status.test.ts`
- Modify: `src/runtime/task-registry.ts` (call `appendPidEntry` after spawn)
- Modify: `src/runtime/subprocess.ts` (replace the 3 inline `task.status = ...` mutations at lines 59 / 143 / 153 with `setStatus(task, ...)` calls)
- Modify: `src/index.ts` (build per-instance pidFilePath via `resolveInstancePidFilePath()`; await `reapOrphans({ pidFileDir, currentInstancePath, ... })` before returning Hooks)
- Modify: `tests/task-registry.test.ts`, `tests/subprocess.test.ts`

**Approach:**
- `src/runtime/task-status.ts`: export `setStatus(task, newStatus, options?: { pidFilePath?: string })`.
  - **Terminal-state guard**: if `task.status` is already terminal (`complete | failed | cancelled`) AND `newStatus` is terminal, the helper no-ops and returns. This preserves the existing `finalizeTask` `if (task.status !== 'cancelled')` invariant: when the subprocess `close` event fires after the abort listener has set `cancelled`, `setStatus(task, 'complete' | 'failed', ...)` is a no-op and `cancelled` is preserved.
  - **Status assignment**: otherwise, `task.status = newStatus`.
  - **Cleanup hook**: if `pidFilePath` is provided and `newStatus` is terminal, calls `removePidEntry(pidFilePath, task.pid).catch(() => {})`. Fire-and-forget.
  - Future contributors can't add a fourth terminal-transition site without picking up both the cleanup hook AND the terminal-state preservation.
- In `src/runtime/task-registry.ts`'s `createTask` (or wherever the task is constructed and spawned): immediately after the subprocess is spawned and `taskState.pid` is known, fetch `comm` and `lstart` via `getPidComm(taskState.pid)` + `getPidStartTime(taskState.pid)` and call `appendPidEntry(pidFilePath, taskState.pid, comm, lstart).catch(() => {})`. Fire-and-forget (do not block task creation).
- In `src/runtime/subprocess.ts`, replace the 3 inline status mutations with `setStatus(task, ...)` calls:
  - Line 59 (`finalizeTask`): the existing `task.status = exitCode === 0 ? 'complete' : 'failed'` becomes `setStatus(task, exitCode === 0 ? 'complete' : 'failed', { pidFilePath })`.
  - Line 143 (abort listener): `task.status = 'cancelled'` becomes `setStatus(task, 'cancelled', { pidFilePath })`.
  - Line 153 (`child.once('error', ...)`): `task.status = 'failed'` becomes `setStatus(task, 'failed', { pidFilePath })`.
- Path injection: `pidFilePath` is constructed once in `src/index.ts` via `resolveInstancePidFilePath()` (Unit 1) and passed through to the registry / subprocess wiring.
- In `src/index.ts`, before the plugin factory returns its `Hooks` object:
  ```
  const pidFileDir = path.dirname(resolveInstancePidFilePath())
  const currentInstancePath = resolveInstancePidFilePath()
  await mkdir(pidFileDir, { recursive: true, mode: 0o700 })
  try {
    await reapOrphans({ pidFileDir, currentInstancePath, killProcessTree, getPidComm, getPidStartTime })
  } catch (err) {
    // Reap failure must not block plugin init.
  }
  return { ...hooks }
  ```
  (Pseudo-code only; actual import/path style follows existing code conventions.)

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Unit (`setStatus`):* `setStatus(task, 'complete', { pidFilePath })` from running state → `task.status === 'complete'`; `removePidEntry` invoked with `task.pid`.
- *Unit (`setStatus` terminal-state guard):* `task.status === 'cancelled'`; call `setStatus(task, 'complete', { pidFilePath })` → `task.status` remains `'cancelled'`; `removePidEntry` NOT invoked. **This is the exact invariant the existing `finalizeTask` guard protects** — directly verifies the cancel survives the close-after-abort sequence.
- *Unit (`setStatus` terminal-state guard):* `task.status === 'failed'`; call `setStatus(task, 'cancelled')` → `task.status` remains `'failed'` (terminal-state idempotent in both directions).
- *Unit (`setStatus`):* `setStatus(task, 'running')` (non-terminal new status) → `task.status === 'running'`; `removePidEntry` NOT invoked.
- *Unit (`setStatus`):* `setStatus(task, 'failed')` without `options` → status set from running; `removePidEntry` NOT invoked (path optional).
- *Unit (`setStatus`):* `removePidEntry` rejection is swallowed; no propagation.
- *Integration:* Spawn a task via `createTask` → PID file contains one entry with `<pid>\t<comm>\t<lstart>`; `comm` matches the spawned binary's name.
- *Integration:* Task `close` (exit 0) → `setStatus(task, 'complete')` called from line 59; PID file no longer contains the entry.
- *Integration:* Abort signal → `setStatus(task, 'cancelled')` called from line 143; PID file no longer contains the entry.
- *Integration:* Spawn `error` → `setStatus(task, 'failed')` called from line 153; PID file no longer contains the entry.
- *Integration (cancel-then-close ordering):* Abort signal fires first (line 143 → `setStatus` sets `cancelled`); subsequent subprocess `close` event fires (line 59 → `setStatus(task, 'complete' | 'failed', ...)`); final `task.status` is `'cancelled'`, not `'complete'`/`'failed'`. Verifies the terminal-state guard end-to-end at the call sites, not just at the helper level. PID file removal happens once (on the cancellation), idempotent on the `close` event.
- *Edge case:* PID-file write throws (injected mock) → task creation still succeeds; status transition still happens; no exception propagates.
- *Lifecycle:* Plugin init invokes `reapOrphans` exactly once before returning Hooks; reap throw is caught.
- *Lifecycle:* `pidFileDir` is created with `mode: 0o700` if it doesn't exist.

**Verification:** All scenarios pass; existing task-registry and subprocess tests still pass.

---

- [x] **Unit 4: Parser cancel-race guard**

**Goal:** Single-line guard at the top of the inline JSONL data handler in `spawnCopilot`.

**Requirements:** R2.

**Dependencies:** None (independent of Units 1–3).

**Files:**
- Modify: `src/runtime/subprocess.ts`
- Modify: `tests/subprocess.test.ts`

**Approach:**
- Locate the existing `child.stdout?.on('data', (chunk: string) => { ... })` callback inside `spawnCopilot`. Inside the `for (const line of lines)` loop, place the guard **before** `parseJsonlLine(line)` (not before `events.push`) so a cancelled task does not pay the parse cost on buffered lines: `if (task.status !== 'running') break;`.
- The partial-line buffer update (`lines.pop()`) runs *before* the loop body, so `break` and `return` are equivalent at this point — `break` is the natural choice for an in-loop early-exit.
- Single-threaded JS guarantees: the guard is checked synchronously with every iteration; once `task.status` flips, no subsequent loop iteration in this or future `data` ticks will parse or append.
- This is a 1-2 line change; the test scenario carries the weight.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Edge case (cancel race):* Spawn a fake subprocess that emits 5 JSONL lines slowly. After line 2 is parsed, set `task.status = 'cancelled'` (simulating the abort listener). Allow the remaining 3 lines to drain through the parser. Assert: `task.events.length === 2`; the 3 post-cancel events are NOT appended.
- *Happy path (no regression):* Without cancel, all 5 events parse and append normally.
- *Edge case (cancel before any events):* Set `status = 'cancelled'` before the first `data` callback fires. Assert: `task.events.length === 0`.

**Verification:** All scenarios pass; existing `subprocess.test.ts` scenarios still pass; no regressions in `tests/tools.test.ts`.

---

## Definition of Done (PR housekeeping; not a planning unit)

- **README.md**: under Known Limitations, update the "PID-file reaper: planned for v1.x" entry to reflect v0.1.1 shipping. Add a one-line note about POSIX `ps` dependency.
- **AGENTS.md**: extend the architecture tree to include `src/runtime/orphan-reaper.ts` and `src/runtime/pid-file.ts`. One sentence on the reaper's init-time sequencing.
- **Single patch changeset for the v0.1.1 PR.** (Patch bump in the unstable `0.x` series for a behavior-preserving correctness fix; `minor` is reserved for new features under the repo policy.)

## System-Wide Impact

- **Interaction graph:** Plugin init builds the per-instance pid file path, ensures the orphans directory exists at `0o700`, and `await`s `reapOrphans()` before returning Hooks (the SDK contract guarantees no tool dispatch until that resolves). Task spawn calls `appendPidEntry` (fire-and-forget). All three terminal-transition sites in `subprocess.ts` now flow through the `setStatus` helper, which calls `removePidEntry` for terminal states.
- **Error propagation:** All PID-file I/O errors are swallowed at the call site (`.catch(() => {})`). Reaper failures are caught per-PID and at the top level; no failure mode blocks plugin init or task creation.
- **State lifecycle risks:** Per-instance PID files (`<state-dir>/orphans/<discriminator>.pids`) eliminate the cross-instance file-clobbering risk that a single shared file would create. Within an instance, the in-process serialization queue in `pid-file.ts` orders concurrent appends/removes from the existing 10-task cap with no lost updates. File perms `0o600` and parent dir `0o700` defend against arbitrary-process-injection. The reap-vs-spawn race during init is closed by the awaited factory contract.
- **API surface parity:** No changes to existing tool inputs/outputs.
- **Integration coverage:** Unit 3's "Integration" scenarios exercise the cross-layer flow (task spawn → file append; each of the 3 terminal-transition sites → `setStatus` → file remove). Manual smoke on macOS and Linux at implementation time covers the `ps` portability concern; the `ps -o comm=` field is widely supported.
- **Unchanged invariants:** `MAX_CONCURRENT`, `cpl_` task ID prefix, all existing tool surfaces, `bun build` artifact shape, the existing `task.status` runtime semantics (the `setStatus` refactor preserves the same observable transitions — same status values, same ordering, same callers; only the cleanup hook is added).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ps -p <pid> -o {comm,lstart}=` portability across BSD vs GNU `ps`, including minimal images (Alpine busybox) | Implementation-time smoke test on dev hosts. `comm` and `lstart` are both widely supported on mainstream macOS / Linux. If unavailable, the reaper logs and skips — does not crash. Document POSIX `ps` dependency in README. |
| PID file write fails on disk-full or signal mid-rename | Atomic rename ensures no partial reads. Worst case: missed-remove → extra reap attempt of an already-dead PID, which is tested and idempotent. |
| Malicious PID file injection on shared machines | File perms `0o600` + `0o700` parent dir as primary defense. Identity gate combines exact `comm` match AND exact `lstart` match AND PID liveness — forging requires write access to the protected file. |
| Parser guard's `break` placement subtle (must not skip the partial-line buffer update) | Implementation reads the actual handler structure first; the `lines.pop()` partial-line buffer update happens *before* the loop body, so `break` and `return` are equivalent. Test scenario asserts post-cancel events are not appended and the buffer is preserved. |
| Reap blocks plugin init at `MAX_CONCURRENT = 10` historical entries | Parallel per-PID probes with a worker-pool concurrency cap of 5. Each PID's check is two `ps` shellouts (`comm` + `lstart`) plus a liveness probe. Soft target: total reap time under 200ms on a typical dev host. Verified by Unit 2's latency test scenario. |
| Cross-instance file clobbering (shared single PID file would silently drop live PIDs across concurrent OpenCode sessions) | **Resolved by per-instance file design**: each instance writes to `<state-dir>/orphans/<plugin-pid>.pids` and only truncates its own file. Reap reads the entire directory so foreign-instance survivors are still recovered. |
| Cross-instance kill of a live foreign instance's child (identity gate alone is insufficient — a live foreign instance's subprocesses pass `comm`+`lstart` match) | **Resolved by spawner-liveness gate**: each foreign file's owning plugin PID is parsed from the filename and probed via `process.kill(<pid>, 0)`. Alive (or `EPERM`) → skip the entire file. Dead → reap entries and delete the file. |
| `<state-dir>/orphans/` directory grows without bound across many sessions | **Resolved by post-reap deletion**: after a successful reap of a foreign file (dead spawner), the file itself is deleted. Long-lived dev hosts see one transient file per active plugin instance, not historical accumulation. |
| `setStatus` refactor introduces regression in existing 3 status-mutation sites | Three sites are explicit and enumerated by line number (subprocess.ts:59, :143, :153). Helper enforces terminal-state idempotency (preserves `cancelled` if `close` fires after abort) so the existing `finalizeTask` `if (task.status !== 'cancelled')` invariant is preserved automatically rather than being re-implemented at the call site. Test scenarios per site verify both the status transition and the cleanup hook fire; an explicit `cancelled → complete` no-op test directly verifies the invariant. Existing subprocess tests continue passing as a regression gate. |


## Documentation / Operational Notes

See "Definition of Done" above.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md](../brainstorms/2026-04-27-copilot-status-tui-requirements.md) §"Prerequisites for ce:plan" #3
- **Follow-up plan:** [docs/plans/2026-04-27-001-feat-copilot-status-tui-foundation-plan.md](2026-04-27-001-feat-copilot-status-tui-foundation-plan.md)
- Related code: `src/runtime/subprocess.ts`, `src/runtime/task-registry.ts`, `src/lib/kill-tree.ts`
- Institutional learnings: `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md`
