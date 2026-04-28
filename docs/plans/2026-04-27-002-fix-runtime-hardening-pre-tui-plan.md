---
title: "fix: pre-TUI runtime hardening (orphan reaper + cancel-race parser guard)"
type: fix
status: active
date: 2026-04-27
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

- **PID file location**: `<XDG_STATE_HOME or ~/.local/state>/opencode-copilot-delegate/orphans.pids`. Plain text, line-delimited, format `<pid>\t<ps-lstart-output>` (tab-separated to avoid colon ambiguity in the lstart string). Parent directory created with `0o700`; file written with `0o600`.
- **Start-time source for the recorded value**: at task spawn, immediately invoke `ps -p <pid> -o lstart=` (array-spawn, no shell) and store the returned string verbatim. This guarantees the recorded value matches the format `ps` will return at reap time. (Do **not** use `task.startedAt` epoch ms — `ps` and `Date.now()` produce incomparable strings.)
- **`ps` invocation**: `child_process.spawn('ps', ['-p', String(pid), '-o', 'lstart='])` with no shell. Eliminates command-injection risk if the PID file is malformed.
- **PID-file lock strategy**: `node:fs` `O_EXCL` temp-file + atomic `rename` for both append and remove. No new dep. Concurrency at the existing 10-concurrent cap is light enough that worst-case "one writer's update overwritten by a slightly-stale concurrent writer" is acceptable; the reaper handles a missed-removal as an extra reap-attempt of an already-dead PID, which is a tested scenario. The constant lives in `fs.constants.O_EXCL` (not `os.constants`).
- **PID-validate-before-kill**: Before invoking `killProcessTree(pid)`, double-check that the process command line contains `copilot` via `ps -p <pid> -o args=` (array-spawn). If the command does not match, skip with a logged warning. Defense-in-depth against malicious PID file injection (file perms 0o600 are the primary defense).
- **Reap sequencing**: Reap runs synchronously during plugin init, before the plugin returns. v0.2.0's RPC server starts after this completes. v0.1.1 has no RPC server, so the only consumer of the post-reap state is the registry itself.
- **Parser guard placement**: In `spawnCopilot`, at the top of the existing inline `child.stdout?.on('data', (chunk: string) => { ... })` handler, immediately before the line-iteration loop's `events.push(event)` — `if (task.status !== 'running') break;` (use `break` rather than `return` so the partial-line buffer state at the bottom of the handler still updates). Single-threaded JS guarantees the guard is checked synchronously with every push, with no interleaving possible.

## Open Questions

### Resolved During Planning

- **PID-file format**: tab-separated `<pid>\t<lstart-string>`. Captures the exact `ps` output verbatim.
- **Start-time source**: live `ps` at spawn time, not `Date.now()`. Eliminates format mismatch.
- **`ps` shell vs array spawn**: array-spawn, no shell.
- **PID-validate-before-kill via `ps -p <pid> -o args=`**: yes, as defense-in-depth.

### Deferred to Implementation

- **`ps -p <pid> -o lstart=` portability across BSD vs GNU `ps`**: macOS BSD `ps` is verified by direct test during implementation. Linux GNU `ps` ships `lstart` in `procps-ng` (mainstream distros) but may differ on minimal images (Alpine `busybox ps`). Implementation-time gate: write a small smoke test asserting `ps -p $$ -o lstart=` returns a non-empty parseable value on the dev host; document the dependency in README and AGENTS.md.

## Output Structure

```
src/
├── runtime/
│   ├── orphan-reaper.ts           # PID file reap logic + ps shell-out + validate-before-kill
│   ├── pid-file.ts                # appendPidEntry, removePidEntry helpers
│   ├── subprocess.ts              # (modified) parser guard at top of inline data handler
│   └── task-registry.ts           # (modified) wire pid-file hooks on spawn + terminal transition
└── index.ts                       # (modified) call reapOrphans during plugin init

tests/
├── orphan-reaper.test.ts          # Reap scenarios (alive matching, alive mismatched, dead, malformed, validate-before-kill)
├── pid-file.test.ts               # Append, remove, concurrent writers, atomic rename
├── subprocess.test.ts             # (modified) cancel-race scenario: post-cancel events not appended
└── task-registry.test.ts          # (modified) PID-file hooks fire on spawn + terminal
```

## Implementation Units

- [ ] **Unit 1: PID-file helpers (`pid-file.ts`)**

**Goal:** Atomic append + remove for the PID file.

**Requirements:** R1 (persistence layer for the reaper).

**Dependencies:** None.

**Files:**
- Create: `src/runtime/pid-file.ts`
- Create: `tests/pid-file.test.ts`

**Approach:**
- Export `appendPidEntry(filePath, pid, startTimeString) → Promise<void>` and `removePidEntry(filePath, pid) → Promise<void>`.
- Append: read existing content (or empty if missing), construct new content with the appended `<pid>\t<startTime>` line, write to `<path>.tmp.<random>` with `fs.constants.O_EXCL | O_CREAT | O_WRONLY` and `mode: 0o600`, `fs.rename` to final path, `fs.chmod(path, 0o600)` for belt-and-braces.
- Remove: same flow, but compute new content by filtering out the matching `pid` prefix.
- Ensure parent dir with `mkdir({ recursive: true, mode: 0o700 })`.
- Both functions tolerate a missing file: append creates it; remove is a no-op.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Happy path:* `appendPidEntry` to a fresh path → file exists with one line; mode is 0o600.
- *Happy path:* `appendPidEntry` 3 times sequentially → file has 3 lines in order.
- *Happy path:* `removePidEntry(pid)` on a file with 3 entries removes only the matching one.
- *Edge case:* `appendPidEntry` to a non-existent parent dir → dir is created with 0o700; file written.
- *Edge case:* `removePidEntry` for a PID not in the file → no-op, no error.
- *Edge case:* `removePidEntry` on a missing file → no-op, no error.
- *Concurrency:* `appendPidEntry` invoked 10x concurrently → file ends with 10 entries (no interleaving), via the atomic rename serialization.
- *Mode:* After both append and remove, file mode remains `0o600`.

**Verification:** All scenarios pass; `bun run typecheck` + `bun run lint` clean.

---

- [ ] **Unit 2: Orphan reaper (`orphan-reaper.ts`)**

**Goal:** Read the PID file at init time, reap survivors with PID-validate-before-kill.

**Requirements:** R1.

**Dependencies:** Unit 1.

**Files:**
- Create: `src/runtime/orphan-reaper.ts`
- Create: `tests/orphan-reaper.test.ts`

**Approach:**
- Export `reapOrphans({ pidFilePath, killProcessTree, getPidStartTime, getPidArgs }) → Promise<{ reaped: number, skipped: number }>`. Inject all process-shellouts for testability.
- `getPidStartTime(pid)`: `spawn('ps', ['-p', String(pid), '-o', 'lstart='])` with no shell. Return trimmed stdout, or `null` on non-zero exit / process gone.
- `getPidArgs(pid)`: `spawn('ps', ['-p', String(pid), '-o', 'args='])`. Return trimmed stdout, or `null`.
- Read PID file; parse `<pid>\t<startTimeString>` per line; ignore malformed lines.
- For each entry:
  1. Probe liveness: `process.kill(pid, 0)` inside try/catch. Throws → process gone, skip + remove entry.
  2. Check start-time match: live `getPidStartTime(pid)` === recorded value. Mismatch → PID reused, skip + remove entry (don't kill the unrelated process).
  3. Validate command: `getPidArgs(pid)` contains `copilot`. No match → skip + log warning (defense-in-depth).
  4. Kill: `killProcessTree(pid)` inside try/catch. Catch-all ensures one bad PID doesn't stop the loop.
- After processing all entries, truncate the file (the reaped PIDs are now dead; new entries will be re-appended on subsequent task spawns).
- Aggregate `reaped` / `skipped` counts; return.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Happy path:* Empty PID file → `{ reaped: 0, skipped: 0 }`; file truncated.
- *Happy path:* One alive PID with matching start time + `copilot` in args → `killProcessTree` called once; `{ reaped: 1, skipped: 0 }`.
- *Edge case (PID dead):* `process.kill(pid, 0)` throws → not killed; skipped; entry removed; `{ reaped: 0, skipped: 1 }`.
- *Edge case (start-time mismatch):* Alive PID, recorded start time differs → not killed (PID reuse); skipped; entry removed.
- *Edge case (args mismatch):* Alive PID, matching start time, but `args` does not contain `copilot` → not killed; skipped + warned.
- *Edge case (mixed):* Three entries (alive-match, alive-args-mismatch, dead) → `{ reaped: 1, skipped: 2 }`; file empty after.
- *Edge case (missing file):* `pidFilePath` does not exist → `{ reaped: 0, skipped: 0 }`; no error.
- *Error path:* Malformed line → skipped silently; valid lines still processed.
- *Error path:* `killProcessTree` throws (injected) → caught, counted as skipped; loop continues.
- *Error path:* `getPidStartTime` returns `null` for an alive PID (race) → skipped, no kill.

**Verification:** All scenarios pass; manual smoke on macOS dev host: spawn `sleep 60`, write its PID + recorded start time, simulate plugin re-init, confirm sleep is killed. Smoke on Linux dev host: same.

---

- [ ] **Unit 3: Wire pid-file hooks into task-registry**

**Goal:** Append on task spawn; remove on terminal transition.

**Requirements:** R1.

**Dependencies:** Units 1, 2.

**Files:**
- Modify: `src/runtime/task-registry.ts`
- Modify: `src/runtime/subprocess.ts` (terminal-transition callsites: `finalizeTask`, the abort listener, the `child.once('error', ...)` handler)
- Modify: `src/index.ts` (build pidFilePath at init, pass through, call reapOrphans before plugin returns)
- Modify: `tests/task-registry.test.ts`

**Approach:**
- In `task-registry.ts`'s `createTask` (or wherever the task is constructed and spawned): immediately after the subprocess is spawned and `taskState.pid` is known, fetch the start-time string via `getPidStartTime(taskState.pid)` and call `appendPidEntry(pidFilePath, taskState.pid, startTimeString).catch(() => {})`. Fire-and-forget (do not block task creation).
- In `subprocess.ts`'s three terminal-transition sites (`finalizeTask`, abort listener, `child.once('error', ...)`): immediately after setting `task.status` to `complete | failed | cancelled`, call `removePidEntry(pidFilePath, taskState.pid).catch(() => {})`. Fire-and-forget.
- Path injection: the `pidFilePath` is constructed once in `src/index.ts` at plugin init and passed through to the registry / subprocess wiring. Default: `<XDG_STATE_HOME or ~/.local/state>/opencode-copilot-delegate/orphans.pids`.
- In `src/index.ts`, before the plugin factory returns: `await reapOrphans({ pidFilePath, killProcessTree, getPidStartTime, getPidArgs })`. Wrap in try/catch — reap failure should never block plugin init.

**Execution note:** Test-first per AGENTS.md mandate.

**Test scenarios:**
- *Integration:* Spawn a task via `createTask` → PID file contains one entry with the spawned PID and a non-empty start-time string.
- *Integration:* Task transitions to `complete` (via `finalizeTask`) → PID file no longer contains the entry.
- *Integration:* Task transitions to `cancelled` (via abort listener) → PID file no longer contains the entry.
- *Integration:* Task fails (`child.once('error', ...)`) → PID file no longer contains the entry.
- *Edge case:* PID-file write throws (injected mock) → task creation still succeeds; transition still happens.
- *Lifecycle:* Plugin init invokes `reapOrphans` exactly once before returning.

**Verification:** All scenarios pass; existing task-registry tests still pass.

---

- [ ] **Unit 4: Parser cancel-race guard**

**Goal:** Single-line guard at the top of the inline JSONL data handler in `spawnCopilot`.

**Requirements:** R2.

**Dependencies:** None (independent of Units 1–3).

**Files:**
- Modify: `src/runtime/subprocess.ts`
- Modify: `tests/subprocess.test.ts`

**Approach:**
- Locate the existing `child.stdout?.on('data', (chunk: string) => { ... })` callback inside `spawnCopilot`. Inside the `for (const line of lines)` loop, immediately before `events.push(event)`, add: `if (task.status !== 'running') break;` (use `break` not `return` so the buffered partial-line state at the bottom of the handler still updates correctly — verify the actual handler's structure at implementation time).
- Single-threaded JS guarantees: the guard is checked synchronously with every push; once `task.status` flips, no subsequent loop iteration in this or future `data` ticks will append.
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

- **Interaction graph:** Plugin init now does PID-file I/O before returning. Task spawn and terminal transitions write to the PID file (fire-and-forget).
- **Error propagation:** All PID-file I/O errors are swallowed (`.catch(() => {})`). Reaper failures are caught per-PID; no failure mode blocks plugin init or task creation.
- **State lifecycle risks:** PID file is the new shared state. Concurrency at the 10-concurrent cap is acceptable; worst-case is an extra reap attempt of a dead PID. File perms are 0o600 to defend against arbitrary-process-injection.
- **API surface parity:** No changes to existing tool inputs/outputs.
- **Integration coverage:** Unit 3's "Integration" scenarios exercise the cross-layer flow (task spawn → file append; terminal transition → file remove). Manual smoke on macOS and Linux at implementation time covers the `ps` portability concern.
- **Unchanged invariants:** `MAX_CONCURRENT`, `cpl_` task ID prefix, all existing tool surfaces, `bun build` artifact shape.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ps -p <pid> -o lstart=` portability across BSD vs GNU `ps`, including minimal images (Alpine busybox) | Implementation-time smoke test on dev hosts. Document POSIX `ps` dependency in README. If `lstart` is unavailable, the reaper logs and skips — does not crash. |
| PID file write fails on disk-full or signal mid-rename | Atomic rename ensures no partial reads. Worst case: missed remove → extra reap attempt of a dead PID, which is tested. |
| Malicious PID file injection on shared machines | File perms 0o600 + 0o700 parent dir as primary defense. PID-validate-before-kill (`args` contains `copilot`) as defense-in-depth. |
| Parser guard's `break` placement subtle (must not skip the partial-line buffer update) | Implementation reads the actual handler structure first; test scenario asserts post-cancel events are not appended. |
| Reap blocks plugin init for slow `ps` calls | Each `ps` call is a single-PID query; bounded by `MAX_CONCURRENT = 10` historical entries. Total reap time should be well under 1s in practice. |

## Documentation / Operational Notes

See "Definition of Done" above.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md](../brainstorms/2026-04-27-copilot-status-tui-requirements.md) §"Prerequisites for ce:plan" #3
- **Follow-up plan:** [docs/plans/2026-04-27-001-feat-copilot-status-tui-foundation-plan.md](2026-04-27-001-feat-copilot-status-tui-foundation-plan.md)
- Related code: `src/runtime/subprocess.ts`, `src/runtime/task-registry.ts`, `src/lib/kill-tree.ts`
- Institutional learnings: `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md`
