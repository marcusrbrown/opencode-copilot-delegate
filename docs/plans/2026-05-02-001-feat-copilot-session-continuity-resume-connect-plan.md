---
title: Copilot session continuity — resume + connect
type: feat
status: active
date: 2026-05-02
origin: docs/brainstorms/2026-05-02-copilot-session-continuity-requirements.md
---

# Copilot session continuity — resume + connect

## Overview

Add `copilot_resume` and `copilot_connect` tools that wrap the Copilot CLI's `--resume[=id|name|prefix]` and `--connect[=sessionId]` flags, and surface inline `Resume by ID` / `Connect by ID` affordances inside the existing `/copilot-status` modal. Continuity-derived tasks share the existing `TaskState` shape, distinguished by an `origin: 'spawn' | 'resume' | 'connect'` discriminator so cancel, output, and notify behave truthfully — including for borrowed processes the current plugin instance did not spawn the underlying Copilot session for.

This is the first slice of S2. Fork is explicitly deferred to a follow-up slice; ACP, persistent plugin-side session storage, transcript replay, and watchdog behavior remain out of scope.

## Problem Frame

The plugin is strong at spawning fresh delegations and weak at picking useful work back up once it leaves the happy path. A delegation that times out, loses its parent OpenCode session, or needs to continue elsewhere forces the user back into raw `copilot` CLI usage. The CLI already exposes `--resume` and `--connect` primitives; the gap is productizing them safely — session targeting, workspace re-application, and structured failure handling are not yet exposed through plugin tools or the TUI.

(see origin: `docs/brainstorms/2026-05-02-copilot-session-continuity-requirements.md`)

## Requirements Trace

- R1. Resume and connect ship as first-class continuity actions, not hidden flags on `copilot_delegate`. (Units 3c, 5)
- R2. Raw Copilot session identities are first-class targets alongside plugin `cpl_*` task IDs. (Units 1, 3b, 3c, 5)
- R3. When a known plugin task matches the target, prefer it as the default lookup path while still allowing direct raw-ID targeting. (Units 1, 3c, 5)
- R4. Resume and connect via explicit raw Copilot session identity remain available after plugin or OpenCode restart. The plugin accepts user-provided raw IDs and does not retain a plugin-owned session catalog across restarts. The Recent Sessions view (Unit 5) is a *view onto Copilot CLI's own filesystem catalog*, not a plugin-owned cache. (Units 3c, 5, 6)
- R5. ACP is deferred. (Out of scope.)
- R6. Continuity actions re-apply known prior workspace context (`cwd` and `--add-dir` set). (Units 1, 3c, 5)
- R7. When workspace metadata is unavailable, the flow makes the gap explicit. TUI launches default to current `directory`; tool-path callers (`copilot_resume`, `copilot_connect`) accept explicit `cwd` / `addDirs` arguments for power-user customization. (Units 3c, 5)
- R8. User-facing copy distinguishes resume from connect; users do not infer Copilot semantics from raw flags. Cancel confirm-card copy distinguishes connect-disconnect from spawn/resume-cancel. (Units 2, 3c, 5, 6)
- R9. Invalid, unreachable, or incompatible continuity targets fail with a structured, specific error rather than silently falling back to a fresh delegation. R9 is acknowledged as Copilot CLI 1.0.40-conditional in scope (see Security & Input Validation). (Units 3a, 3b, 3c)
- R10. Dedicated user-facing continuity tools, not encoded as raw flags through `copilot_delegate`. (Unit 3c)
- R11. Continuity actions return a current-process plugin task handle. Continuity-derived tasks share `TaskState` with an `origin` discriminator; borrowed-process state is treated explicitly so cancel, output, and notify behave truthfully rather than silently no-op. (Units 1, 2)
- R12. `/copilot-status` acts as an action launcher for continuity. (Unit 5)
- R13. `/copilot-status` surfaces inline `Resume by ID` / `Connect by ID` affordances inside the existing modal. No separate slash commands required. (Unit 5)
- R14. Continuity actions launched from `/copilot-status` produce a live result that is immediately visible and controllable through the existing status surface. (Units 4, 5)
- R15. Composes with the existing S1 TUI/status foundation; no new always-visible panel. (Unit 5)
- R16. Works without persistent plugin-owned task storage as a prerequisite. (Architectural — Unit 3's `session-store` is read-only against the upstream Copilot CLI's own filesystem; no plugin-side files are written. Verified by Unit 3 test scenarios that exercise no-write paths only.)
- R17. Does not require transcript replay, watchdog, or ACP. (Out of scope.)

## Scope Boundaries

- ACP-mediated long-lived sessions; any ACP-backed default strategy.
- Persistent plugin-owned session or task storage across restarts.
- Transcript replay, export, or post-mortem browsing.
- Watchdog or stall-detection behavior.
- Replacing the Copilot CLI session model with a plugin-owned conversation store.
- A separate continuity dashboard or always-visible panel outside `/copilot-status`.

### Deferred to Separate Tasks

- Fork from a prior session — UX-only branching that internally calls resume with a new prompt and an `origin: 'fork'` discriminator. Follow-up slice once resume + connect are shipping cleanly. (see origin: `docs/brainstorms/2026-05-02-copilot-session-continuity-requirements.md`)
- Ambiguous-prefix detection for `--resume=<prefix>` (per Copilot CLI research, multi-match behavior was not observable in testing — defer until a real reproducer exists; one open question item).
- Workspace-metadata cache file for restart-survivable known-task lookup. Today the brainstorm explicitly opts out of plugin-side persistence; revisit only if real users complain about losing known-task lookups across restarts.

## Context & Research

### Relevant Code and Patterns

- `src/runtime/subprocess.ts` (`spawnCopilot` lines 91-181) — flag-agnostic spawn; argv built entirely by callers. New tools build their own argv with `--resume=` / `--connect=`. Reuse `--output-format json -s --no-ask-user`.
- `src/runtime/task-registry.ts` (`TaskState` lines 7-24, `createTask` lines 28-64) — single registry write entry. Discriminator + new optional fields slot in additively.
- `src/runtime/task-status.ts` — centralized `setStatus` helper. All terminal transitions for new code paths must route through it (per learning: `docs/solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md`).
- `src/tools/delegate.ts` (`createDelegateTool` lines 62-208) — model factory shape. `appendRepeatedFlag` (lines 23-31) is reusable.
- `src/tools/output.ts`, `src/tools/cancel.ts` — existing tool shapes; cancel response branches on origin in Unit 2.
- `src/runtime/cancel-helper.ts` (lines 14-26) — shared cancel helper that the cancel tool and RPC server both call. Topology to mirror for `launchResume` / `launchConnect`.
- `src/runtime/rpc-contract.ts` + `src/runtime/rpc-server.ts` (`handleRpcRequest` lines 343-361) + `src/tui/rpc-client.ts` (lines 344-377) — RPC extension topology.
- `src/runtime/notify.ts` (`notifySpawn` line 80, `buildNotificationText` lines 111-132, `notifyCompletion` lines 141-197) — completion pipeline branches on origin in Unit 2; `notifySpawn` toast text becomes origin-aware.
- `src/runtime/envelope.ts` (`buildEnvelope` lines 121-157) — output envelope; threads `origin` in Unit 1.
- `src/lib/normalize-tool-arg-schemas.ts` (lines 73-80) — every new tool registers through this, exercised by the tools.test.ts schema-walk case set.
- `src/runtime/plugin-singleton.ts` (`plugInOnce`) — every new init path routes through this.
- `src/tui/components/modal-list.tsx` (render lines 199-230) — primary modal; new affordances slot above or below the rows section.
- `src/tui/components/confirm-card.tsx` — focus + key handling idiom for new input/confirm flows.
- `@opentui/core/renderables/Input` (`InputRenderable`) — text input primitive available but not yet used; required for the raw-ID input affordance and missing-workspace inputs form.
- `src/tui/index.tsx` (lines 34-46) — `api.ui.dialog.replace(() => <Component />)` swap pattern.
- `tests/tools.test.ts` (tool catalog assertion lines 206-219, schema cases lines 232-261) — must extend to 5 tools.
- `tests/fixtures/` — happy-path / multi-tool / model-error captures (flat layout, no `jsonl/` subdir); resume reuses happy-path; connect needs one new fixture for partial-stream attach.

### Institutional Learnings

- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md` — top-level async guards on every RPC route, structured 500s, request-token + disposed guards on TUI modal state mutations after RPC response. Directly shapes Units 4 and 5.
- `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md` — never `clear()` then `replace()`; host owns teardown, child reports failures upward. Shapes Unit 5 dialog flow.
- `docs/solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md` — borrowed processes (connect) violate the spawner-ownership invariant. Connect-mode tasks must NOT enter the orphan PID ledger; treat them as un-reapable. Shapes Units 1 and 3.
- `docs/solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md` — every terminal transition (including connect-disconnect, attach race, borrowed-process-already-exited) routes through `setStatus`; for borrowed-process tasks, `pidFilePath` is omitted. Shapes Units 1, 2, 3.
- `docs/solutions/best-practices/secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md` — for any PID loaded from external state (the connect target), reuse `getPidIdentity()` to capture `comm + lstart` at attach time and verify before any later destructive action. Shapes Unit 1 (`psIdentity` field on TaskState) and Unit 3 (capture in connect path).
- `docs/solutions/best-practices/atomic-file-append-remove-o-excl-temp-file-2026-04-28.md` — constraint check: this slice must not introduce a new persistent state file. If a workspace cache is ever added, it inherits the full `O_EXCL` + `serializeWrite` + `rename` discipline.
- `docs/solutions/best-practices/bounded-concurrency-worker-pool-chunked-promise-all-2026-04-28.md` — relevant only if the modal grows session-validation enrichment (out of scope for this slice).

### External References

- Copilot CLI 1.0.40 failure-mode catalog (captured this session via `copilot_delegate` empirical run): see Key Technical Decisions below for the normalization table.
- `docs/research/copilot-cli-capabilities-2026-04-27.md` (§1, §10.12, §11) — `--resume` / `--connect` flag reference, "Resume / fork" pattern, and gotchas including the path-sandbox-not-persisted note (`--add-dir` must be re-passed on resume).

## Key Technical Decisions

- **Origin discriminator on `TaskState`**, not a separate borrowed-task type. Single registry, single envelope shape, one branching point per consumer (notify text, cancel response, output envelope). Rationale: minimizes refactor surface; consumers that don't care about origin keep working unchanged. (R11)
- **Borrowed sessions are un-reapable; the local connector PID is owned.** `origin === 'connect'` tasks bind the local plugin process to a *remote Copilot session* the plugin instance did not originate. The local connector PID IS owned by this plugin instance and is killed on cancel; the remote session continues independently. Connect tasks do NOT write to the orphan PID ledger because the ledger's spawner-liveness gate concerns the *remote session's lifecycle*, not the connector's. Cancel response wording reflects this truthfully (`disconnected: true` for connect; `cancelled: true` for spawn/resume). Throughout this plan, "borrowed" refers to the remote Copilot session; the local connector PID is always owned and killable.
- **No new internal `disconnected` status.** Connect-disconnect uses the existing `cancelled` terminal state; the envelope and notification text disambiguate via the `origin` field rather than via a new status. Rationale: keeps the terminal-state set bounded and avoids ripple changes through `setStatus`, `TERMINAL_STATUSES`, the RPC `TaskStatusSchema`, and `outputStatus`.
- **Pre-flight UUID-existence check for `--resume`**, config-dir aware. When the target is a UUID, stat `${configDir ?? ~/.copilot}/session-state/<uuid>/session.db` and short-circuit with a structured error if absent. `configDir` is read in priority order: explicit tool argument → `COPILOT_CONFIG_DIR` env var → default `~/.copilot/`. Empirical Copilot CLI 1.0.40 finding: passing a valid-format-but-unknown UUID to `--resume` silently creates a new session at exit 0; the pre-flight closes that hole for default-config users and config-dir users equally.
- **`--connect` validation timing is empirical-first.** The plan does NOT assume `result.sessionId` comparison works as an attach-time mismatch detector. The Copilot CLI `result` event is a session-end summary, not a handshake event — by the time it arrives, a spurious new session has already done potentially-destructive work. Unit 3's first sub-step is an empirical capture of a real `--connect` JSONL stream against a known-bad ID to identify whether any *early* session-identity event exists during the connect handshake. The validation strategy crystallizes from that capture; default fallback is honest-deferral (loud warning in tool description; no architectural validation claim) until evidence supports a stronger guarantee.
- **Stderr regex normalization for the no-match path.** Copilot CLI 1.0.40 emits a freeform English `Error: No session, task, or name matched '<value>'` to stderr at exit 1 with no JSONL output. A `normalizeContinuityError(stderr)` helper detects this and returns a clean error message; all other exit-1 paths are passed through verbatim. R9 is acknowledged as Copilot CLI 1.0.40-conditional in scope (the regex is empirical, not a documented contract); a runtime canary on plugin init logs a warning when `copilot --version` differs from the tested range.
- **Resume does NOT take a new prompt argument.** `copilot_resume` continues the resumed session from its last state without injecting a new turn. The semantic of "resume + new prompt" is fork; shipping fork mechanically inside resume would lock in ergonomics the explicit fork tool would need to undo in a follow-up slice. Enforced at the schema level: `copilot_resume` accepts only `targetId`, `cwd?`, `addDirs?`, `configDir?`. Fork remains explicitly deferred (see Scope Boundaries).
- **Two dedicated tools, not one parameterized tool.** `copilot_resume` and `copilot_connect` rather than a single `copilot_continuity { action }`. Rationale: distinct semantics merit distinct tool descriptions; agents discovering tools via tool catalog see two clearly-labeled options with action-specific argument shapes. Tool-catalog cost is acknowledged: this slice grows the catalog from 3 to 5 tools, each consuming agent context-token budget on every turn; consolidation back to one tool would be a deprecation-cycle commitment we accept in exchange for argument-shape clarity.
- **TUI affordances inline in the existing modal, no new slash commands.** Per R13. Two distinct flows:
  - **Resume primary path — `Recent Sessions` view**. Reads `${configDir ?? ~/.copilot}/session-state/` as a directory listing; surfaces selectable rows with mtime + best-effort metadata (project name, first user message snippet, tool-call count) extracted from each session's `events.jsonl`. This is a *view onto Copilot CLI's own catalog*, not a plugin-owned catalog — R4 stays intact. User picks a row → launches resume against that session ID.
  - **Resume fallback / Connect primary — raw-ID input form**. Used when the user wants to resume a session not in the local list, or to connect to a remote/shared session ID (always raw-ID first because connect targets are typically external).
  - Dialog swaps use `api.ui.dialog.replace`, never `clear` + `replace` (per re-entrant dialog close learning).
- **Shared `launchResume` / `launchConnect` helpers exported directly from `src/tools/resume.ts` and `src/tools/connect.ts`**, imported by the RPC routes. No separate `launch-helpers.ts` file — cancel-helper.ts is 12 lines of trivial logic; launch is the entire body of the tools. If a third caller appears (fork in a follow-up slice), extract then.
- **Pre-flight check helpers consolidated in `src/runtime/continuity-checks.ts`** (renamed from `continuity-errors.ts` in the original draft). One file owns both the stderr regex normalization (`normalizeContinuityError`) and the filesystem pre-flight (`hasLocalCopilotSession`). Avoids `session-store.ts` becoming a magnet for future plugin-side persistence creep.
- **`--allow-all-tools` is included in continuity argv.** Required by Copilot CLI for `-p` non-interactive mode; safest assumption for `--resume` and `--connect`. If empirical post-ship feedback shows it breaks anything, narrow it then. Cancel-from-connect uses origin-aware confirm-card copy ("Disconnect from session?" / `Disconnect` / `Stay Connected`) rather than the spawn/resume cancel copy.

## Open Questions

### Resolved During Planning

- **Tool surface shape (R10, R11)**: Two dedicated tools (`copilot_resume`, `copilot_connect`), not a single `copilot_continuity` with action parameter. (See Key Technical Decisions.)
- **Internal representation of borrowed sessions (R11, R14)**: `origin` discriminator on existing `TaskState`; no new status. External consumers (`output.ts`) keep `status: 'cancelled'` for connect-disconnect; the `origin` field carries the truth. (See Key Technical Decisions.)
- **Continuity failure-mode normalization (R9)**: Two reliable signals (exit-1 stderr regex for no-match, config-dir-aware pre-flight UUID stat for resume) plus an empirical-first design for connect (Unit 3a captures real JSONL behavior; ship honest-deferral if no early identity event exists). (See Key Technical Decisions.)
- **Raw-ID launch UX surface (R13)**: Inline modal entries; no new slash commands. Recent Sessions view is the resume primary path; raw-ID input is the fallback for resume and primary for connect.
- **Resume does not accept a new prompt argument**: enforced at the schema level; resume + new prompt would BE fork (which is deferred). Avoids ergonomic lock-in for the agents adopting `copilot_resume`.

### Deferred to Implementation

- Exact regex shape for `normalizeContinuityError(stderr)` — wait for the test fixture to settle before pinning it. Empirical pattern is `/^Error: No session, task, or name matched '(.+)'/m` but tolerate trailing-newline / wrapped-line variants.
- Whether to surface "your `--add-dir` set may not match the original session" hint when the user supplies workspace inputs that differ from a known-task record. Likely a copy decision settled when the form is wired.
- Recent Sessions view's `events.jsonl` metadata extraction — exact heuristic for deriving project name (first user message? `cwd` from session start event?) settled when the parser is implemented and tested against real fixtures.
- `InputRenderable` paste handling quirks (bracketed-paste behavior in OpenTUI) discovered during raw-ID input form implementation; document any in the plan's solution-doc on completion.

### Open (Out of Scope, Tracked)

- **Ambiguous-prefix behavior for `--resume=<prefix>`**: Copilot CLI 1.0.40 multi-match behavior could not be reproduced in research. Tracked under "Deferred to Separate Tasks." Plan revisit only when a reproducer exists.
- **`--connect` remote-API error surface**: Cannot observe without a real `--share` session. Tracked as a future R9-extension.
- **Session-store corruption error shape**: What `--resume=<valid-uuid>` produces when `session.db` exists but is unreadable. Likely a runtime exit ≠ 0 with different stderr text — handle as the generic exit-1 fallback for now.
- **Recursive Copilot sessions**: a resumed session internally spawning child copilot processes (via MCP, hooks, subagents) escapes the origin model and orphan-ledger tracking. Resume-mode orphan tracking only covers the directly-spawned PID. Documented as a known gap; revisit if it manifests as a real problem.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                    ┌─────────────────────────────────┐
                    │ Tool call OR /copilot-status    │
                    │   inline launcher               │
                    └────────────────┬────────────────┘
                                     │
                                     ▼
                       ┌─────────────────────────┐
            ┌──────────│  launchResume / Connect │──────────┐
            │ helper   │  (src/runtime/)         │ helper   │
            │          └─────────────────────────┘          │
            │                                                │
            ▼                                                ▼
   ┌────────────────┐                              ┌────────────────────┐
   │ Pre-flight     │                              │ Post-spawn check   │
   │  for resume:   │                              │  for connect:      │
   │  UUID stat     │                              │  result.sessionId  │
   │  ~/.copilot/   │                              │  vs target         │
   │  session-state │                              │                    │
   │  /<uuid>/.db   │                              │                    │
   └───────┬────────┘                              └────────┬───────────┘
           │ ok                                             │ mismatch
           ▼                                                ▼
   ┌──────────────────┐                          ┌─────────────────────┐
   │ spawnCopilot(    │                          │ structured error,   │
   │  argv with       │                          │ no task created     │
   │  --resume=<id>)  │                          └─────────────────────┘
   └────────┬─────────┘
            │
            ▼
   ┌───────────────────────────────┐
   │ createTask({                  │
   │   origin: 'resume'|'connect', │
   │   copilotSessionId,           │
   │   addDirs,                    │
   │   psIdentity (connect only)   │
   │ })                            │
   └────────────┬──────────────────┘
                │
                ▼
   ┌───────────────────────────────────────────────────┐
   │ attachCompletionPipeline(task, client, origin)    │
   │   (helper introduced in Unit 2)                   │
   │   → notify (origin-aware text)                    │
   │   → setStatus on close (terminal-idempotent)      │
   │   → orphan-ledger write iff origin !== 'connect'  │
   └───────────────────────────────────────────────────┘
```

| Origin | local PID | orphan ledger | cancel response | notify completion text |
|---|---|---|---|---|
| `spawn` | owned | written | `cancelled: true` | "COPILOT DELEGATION COMPLETED" |
| `resume` | owned (new process resuming a CLI session) | written | `cancelled: true` | "COPILOT RESUME COMPLETED" |
| `connect` | owned connector (remote session continues independently) | NOT written | `disconnected: true` | "COPILOT CONNECTOR DISCONNECTED" |

## Implementation Units

- [ ] **Unit 1: Registry + envelope substrate**

**Goal:** Add the `origin` discriminator and supporting fields to `TaskState`, capture `copilotSessionId` from the `result` JSONL event, and thread `origin` through `OutputEnvelope`. Existing `delegate.ts` defaults `origin: 'spawn'`.

**Requirements:** R2, R3, R6, R11

**Dependencies:** None.

**Files:**
- Modify: `src/runtime/task-registry.ts`
- Modify: `src/runtime/subprocess.ts`
- Modify: `src/runtime/envelope.ts`
- Modify: `src/tools/delegate.ts`
- Test: `tests/task-registry.test.ts`
- Test: `tests/envelope.test.ts`
- Test: `tests/subprocess.test.ts`

**Approach:**
- Add to `TaskState` and `CreateTaskInput`: `origin: 'spawn' | 'resume' | 'connect'`, `copilotSessionId?: string`, `addDirs?: string[]`, `psIdentity?: { comm: string; lstart: string }`. `psIdentity` is captured AT SPAWN TIME (synchronous with PID assignment in `subprocess.ts`) for connect-origin tasks; not at first-event time.
- Update single existing `createTask` call site in `delegate.ts` to pass `origin: 'spawn'` + `addDirs: args.add_dir`.
- Capture `copilotSessionId` in `subprocess.ts`: the `result` event arrives at session-end (it's the terminal usage event per `jsonl-parser.ts:37`), so capture happens inside the existing `finalizeTask` flow alongside `assignFinalMessage`. Adequate for resume use cases (registry lookup); insufficient as an attach-time validation signal for connect (handled in Unit 3a).
- Add `origin` to `OutputEnvelope` type and pass-through in `buildEnvelope`.
- Update test fixtures that construct `CreateTaskInput` by hand (~3 sites in `task-registry.test.ts`) to include `origin: 'spawn'`.

**Patterns to follow:**
- `assignFinalMessage` in `src/runtime/subprocess.ts` for the `result`-event capture pattern.
- `CreateTaskInput` extraction pattern (TypeScript `Omit<...>`) already in the file.

**Test scenarios:**
- Happy path: `createTask` accepts `origin: 'spawn' | 'resume' | 'connect'` and stores it on `TaskState`. — registry
- Happy path: `createTask` defaults `origin` to `'spawn'` when omitted from input. — registry
- Happy path: `subprocess.ts` writes `copilotSessionId` to the task when a `result` event with `sessionId` arrives. — subprocess
- Edge case: `result` event without `sessionId` does not throw and leaves `copilotSessionId` undefined. — subprocess
- Happy path: `buildEnvelope` includes `origin` in the output envelope for each origin value. — envelope
- Happy path: `buildEnvelope` includes `origin: 'spawn'` for tasks built by the existing fixtures (back-compat). — envelope

**Verification:**
- All existing tests pass with the new additive fields.
- `OutputEnvelope` consumers (output tool tests) see `origin` populated.
- Type-check + lint clean.

---

- [ ] **Unit 2: Shared completion pipeline + origin-aware notify and cancel**

**Goal:** Extract the completion-pipeline wiring into a shared helper so all three (eventually five) tool factories can attach it consistently. Branch notification text and cancel response on `origin`.

**Requirements:** R8, R9, R11

**Dependencies:** Unit 1.

**Files:**
- Modify: `src/runtime/notify.ts`
- Modify: `src/runtime/cancel-helper.ts`
- Modify: `src/tools/cancel.ts`
- Modify: `src/tools/delegate.ts`
- Test: `tests/notify.test.ts`
- Test: `tests/cancel-helper.test.ts`

**Approach:**
- Extract `attachCompletionPipeline(task, spawnResult, client, origin)` in `notify.ts`: encapsulates `void task.completionPromise.then(...)` + the existing `Object.assign(task, ...)` back-patch + `notifyCompletion(...)`. Existing `delegate.ts:177-204` becomes one call to this helper. **Helper signature includes `spawnResult` separately** because `task` and `spawnResult` are distinct objects after `createTask` (the registry destructures spawn fields into a fresh object); the back-patch of late-arriving fields (`exitCode`, `endedAt`, `finalMessage`, `errorText`) is load-bearing and must not silently drop.
- Branch `buildNotificationText` on `origin` for the section header and action-required text. Three text variants per the table in the High-Level Technical Design section.
- Cancel-helper origin branching is done in the **tool wrappers** (`cancel.ts`), not in `cancel-helper.ts` itself. The helper continues to return `{ cancelled, error? }`; `cancel.ts` reads `task.origin` post-call and translates to `{ disconnected: true, was_running: <bool> }` for connect or `{ cancelled: true, was_running: <bool> }` otherwise. Avoids the `was_running`-fabrication contract change at the helper level.
- **Connect cancel adds an identity-gate step**: before the existing abort-handler chain calls `killProcessTree`, `cancel.ts` (for connect origins only) calls `getPidIdentity(task.pid)` and compares against the captured `task.psIdentity`. On mismatch, log a warning and skip the kill; `setStatus(task, 'cancelled')` still runs (the task IS terminal from the user's perspective). Tests cover both branches.
- Notification toast text on spawn (`notifySpawn`) becomes origin-aware: "Resumed Copilot session …" / "Connected to Copilot session … — invalid IDs may silently start a fresh session, verify the target exists" (warning embedded in the toast for connect origins) / existing for spawn.
- **Confirm-card copy is origin-aware**: `confirm-card.tsx` is parameterized by origin; connect rows use "Disconnect from session?" / `Disconnect` / `Stay Connected` instead of "Cancel Copilot delegation?" / `Cancel Task` / `Keep Running`. (Touches Unit 5 surface but the data-flow change lands here in Unit 2 so the cancel response shape and the UI copy land together.)

**Execution note:** Refactor delegate.ts to use the extracted helper as a no-behavior-change first step; verify tests stay green; then add origin branching.

**Patterns to follow:**
- Existing `notifyCompletion` structure in `src/runtime/notify.ts`.
- Existing in-flight counter logic — origin-agnostic; do not change.

**Test scenarios:**
- Happy path: existing spawn-origin completion pipeline behaves identically after refactor (regression — includes verifying late-arriving fields like `exitCode` and `finalMessage` are written through to the registry task). — notify
- Happy path: `buildNotificationText` returns the resume header for `origin: 'resume'` and the connect header for `origin: 'connect'`. — notify
- Happy path: `notifySpawn` toast for connect origin includes the silent-fallback warning text. — notify
- Happy path: cancel tool returns `{ disconnected: true, was_running: true }` when the target task has `origin: 'connect'` and identity gate passes. — cancel
- Happy path: cancel tool returns `{ cancelled: true, was_running: true }` when the target task has `origin: 'resume'`. — cancel
- Edge case: cancel tool against connect-origin task with mismatched current `psIdentity` logs a warning, skips `killProcessTree`, still transitions task to `cancelled`. — cancel
- Edge case: notify text formatter handles a task with `origin: 'connect'` and a non-zero exit code without crashing. — notify
- Edge case: confirm-card renders connect copy for connect-origin rows. — confirm-card (covered in Unit 5 test set; cross-referenced)

**Verification:**
- All existing tools.test.ts spawn-origin tests stay green.
- New cancel-from-connect test asserts the disconnected response shape.
- Type-check + lint clean.

---

- [ ] **Unit 3a: Empirical pre-flight — capture real `--connect` JSONL behavior**

**Goal:** Before any connect-validation design lands, capture an actual `copilot --connect=<known-bad-id>` JSONL stream and identify whether any *early* session-identity event arrives during the connect handshake (before tool calls or model output).

**Requirements:** R9 (validation strategy depends on empirical evidence)

**Dependencies:** Units 1 and 2.

**Files:**
- Create: `tests/fixtures/connect-attach.jsonl` (real capture against a known-bad ID; PII-scrubbed)
- Create: `tests/fixtures/connect-mismatch.jsonl` (real capture of the silent-fallback case if reproducible)
- Update: `docs/research/copilot-cli-capabilities-2026-04-27.md` §10.12 with the empirical finding

**Approach:**
- Spawn `copilot --connect=00000000-0000-0000-0000-000000000000 --output-format json -s --allow-all-tools --no-ask-user --no-remote -p "noop"` and capture full stdout + stderr.
- Inspect events for any pre-`result` event carrying session identity (look for `assistant.message`, `tool.execution_start`, or other `*.start` events containing `sessionId` in raw payload).
- Document findings in the capabilities reference doc; pick the validation strategy for Unit 3c based on what the capture shows.

**Decision tree based on findings:**
| Finding | Validation strategy for Unit 3c |
|---|---|
| Early event carries `sessionId` | Validate against that event; abort connect on mismatch BEFORE any tool calls fire |
| No early event; only `result` carries it | Honest-deferral posture: ship `--connect` with loud warning in tool description and notification toast; do NOT claim attach-time validation; document upstream gap |
| Connect against unknown ID surfaces clean stderr error at exit ≠ 0 | Use stderr regex normalization (extend `normalizeContinuityError`); no JSONL validation needed |

**Test scenarios:** none (this unit is research; outputs are fixtures + a doc update).

**Verification:**
- Both fixtures committed; capabilities doc updated; the chosen validation strategy is unambiguous before Unit 3c starts.

---

- [ ] **Unit 3b: Pre-flight check helpers and security/input-validation primitives**

**Goal:** Pure functions for stderr normalization, config-dir resolution, UUID detection, filesystem pre-flight checks, and the input-validation primitives the new tool/RPC schemas will depend on.

**Requirements:** R9 (normalization), R4 (config-dir aware after-restart), security findings F1+F2 (input validation)

**Dependencies:** Unit 3a (the empirical finding may shape `normalizeContinuityError`'s pattern set).

**Files:**
- Create: `src/runtime/continuity-checks.ts` — owns `normalizeContinuityError(stderr): string | null`, `resolveConfigDir(explicit?: string): string`, `isCopilotSessionUuid(value: string): boolean`, `hasLocalCopilotSession(uuid: string, configDir: string): Promise<boolean>`
- Create: `src/runtime/continuity-validation.ts` — input-validation helpers shared by tools and RPC: `validateTargetId(value: string): { type: 'uuid' | 'name'; value: string } | { error: string }`, `validateAddDirs(values: string[], allowedRoots: string[]): string[] | { error: string }`, `validateCwd(value: string, allowedRoots: string[]): string | { error: string }`
- Test: `tests/continuity-checks.test.ts`
- Test: `tests/continuity-validation.test.ts`

**Approach:**
- `resolveConfigDir`: priority order = explicit arg → `process.env.COPILOT_CONFIG_DIR` → `${homedir()}/.copilot`. Returns absolute path, no trailing slash.
- `hasLocalCopilotSession`: stat `${configDir}/session-state/${uuid}/session.db`; returns `false` on ENOENT (no throws). Path built via `path.join`, then `path.resolve`-checked to stay under `${configDir}/session-state/` (defense against UUID-shaped path-traversal).
- `validateTargetId`: discriminated return. UUID branch matches `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`; name branch matches `/^[A-Za-z0-9._-]{1,128}$/` (deliberately conservative; widen if Copilot CLI session names use other characters per future research). Anything else returns `{ error: 'invalid target ID format' }`.
- `validateAddDirs`: each entry must (a) not begin with `--` (argv-injection defense), (b) be an absolute path, (c) resolve under one of `allowedRoots` (workspace, `homedir()` minus dotfile dirs by default). `allowedRoots` is computed at launch time from the active workspace + the `directory` plugin option.
- `validateCwd`: same containment as `validateAddDirs` (single value).
- `normalizeContinuityError`: regex set is empirical — starts with `/^Error: No session, task, or name matched '(.+)'/m`; expand based on Unit 3a findings.

**Execution note:** Pure functions, RED-first.

**Patterns to follow:**
- Existing pure-function helpers in `src/runtime/orphan-reaper.ts` (`parsePsIdentity` is the model).
- Existing path-containment patterns in `src/runtime/pid-file.ts`.

**Test scenarios:**
- Happy path: `resolveConfigDir(undefined)` returns `${homedir()}/.copilot`. — checks
- Happy path: `resolveConfigDir('explicit')` returns the explicit value (resolved). — checks
- Happy path: `resolveConfigDir(undefined)` honors `COPILOT_CONFIG_DIR` env when set. — checks
- Happy path: `hasLocalCopilotSession(uuid, configDir)` returns `true` when `session.db` exists. — checks
- Edge case: `hasLocalCopilotSession` returns `false` when directory or file is absent. — checks
- Error path: `hasLocalCopilotSession` with traversal-shaped UUID (e.g. `../../../etc/passwd` made to look UUID-like) is rejected by the path-resolve guard. — checks
- Happy path: `isCopilotSessionUuid(<valid-v4>)` returns true. — checks
- Edge case: short hex prefix returns false. — checks
- Happy path: `validateTargetId(<uuid>)` returns `{ type: 'uuid' }`; `validateTargetId(<name>)` returns `{ type: 'name' }`. — validation
- Error path: `validateTargetId('../../etc/passwd')` returns `{ error }`. — validation
- Error path: `validateTargetId('a'.repeat(200))` returns `{ error }` (length cap). — validation
- Error path: `validateAddDirs(['--allow-tool=shell(*)'])` returns `{ error: 'argv-injection-shaped value' }`. — validation
- Error path: `validateAddDirs(['/etc'])` (outside allowed roots) returns `{ error: 'path outside allowed roots' }`. — validation
- Happy path: `validateAddDirs(['/workspace/sub'])` with `allowedRoots: ['/workspace']` returns the resolved array. — validation
- Happy path: `normalizeContinuityError` matches the no-match stderr pattern and returns the cleaned message. — checks
- Edge case: `normalizeContinuityError` returns null for unrecognized stderr. — checks

**Verification:**
- All helpers covered; no I/O in any helper except `hasLocalCopilotSession` (which only reads).
- Containment guards reject every traversal-shaped input the test set throws at them.

---

- [ ] **Unit 3c: `copilot_resume` and `copilot_connect` tool factories**

**Goal:** Two new tool factories with full argv assembly, validated inputs, pre-flight checks (config-dir aware), origin-aware completion pipeline, and structured error normalization. Both register through `normalizeToolArgSchemas` and `plugInOnce`. `launchResume` and `launchConnect` are exported directly from these files for RPC re-use (Unit 4).

**Requirements:** R1, R2, R3, R6, R7, R8, R9, R10

**Dependencies:** Units 1, 2, 3a, 3b.

**Files:**
- Create: `src/tools/resume.ts` (also exports `launchResume`)
- Create: `src/tools/connect.ts` (also exports `launchConnect`)
- Modify: `src/index.ts` (register both new tools through the existing normalization + plugInOnce pipeline; add startup canary that logs warning when `copilot --version` differs from tested 1.0.40)
- Test: `tests/tools.test.ts` (extend tool-catalog assertion to 5 tools; extend schema-walk cases to include resume/connect args)
- Test: `tests/resume.test.ts`
- Test: `tests/connect.test.ts`

**Approach:**
- `resume.ts` argv: `['--resume=<targetId>', '--output-format', 'json', '-s', '--allow-all-tools', '--no-ask-user']` + `appendRepeatedFlag` for `--add-dir`. Pre-flight: `validateTargetId` first; if `type === 'uuid'`, call `hasLocalCopilotSession(value, resolveConfigDir(args.configDir))`; if false, return `{ error: "No local session found for UUID <id>" }` without spawning. **Resume does NOT accept a `prompt` argument** (semantic alignment: resume + new prompt is fork; deferred to follow-up slice). Schema: `{ targetId: string, cwd?: string, addDirs?: string[], configDir?: string }`.
- `connect.ts` argv: `['--connect=<targetId>', '--output-format', 'json', '-s', '--allow-all-tools', '--no-ask-user', '--no-remote']` + `--add-dir` reuse. Pre-flight: `validateTargetId`. Validation strategy from Unit 3a: if early identity event exists, validate; if not, the tool description and `notifySpawn` toast carry the loud warning that an invalid ID may silently start a fresh session. Capture target PID's `comm + lstart` via `getPidIdentity()` AT SPAWN TIME (synchronous with PID assignment) and store on `TaskState.psIdentity`. Schema: `{ targetId: string, cwd?: string, addDirs?: string[], configDir?: string }`.
- Both tools call `validateAddDirs(args.addDirs, allowedRoots)` and `validateCwd(args.cwd, allowedRoots)` before assembling argv. Validation failures return structured `{ error }` without spawning.
- Lookup-by-known-task (R3): both tools first scan `getAllTasks()` for any task whose `copilotSessionId === targetId`; if found, reuse its captured `addDirs` as workspace context (re-validated through `validateAddDirs`). The lookup returns workspace metadata only — resume/connect always create a new `TaskState`, never alias to a prior task handle.
- `launchResume(opts)` and `launchConnect(opts)` are exported from these files (no separate `launch-helpers.ts`). RPC routes (Unit 4) import them directly.
- `index.ts`: register `copilot_resume` and `copilot_connect` alongside the existing three. Goes through `normalizeToolArgSchemas` walk + `plugInOnce` wrapper automatically.
- **Borrowed-session rule**: connect-mode `createTask` does NOT include the `pidFilePath` orphan-ledger write hook (the *remote session* lifecycle is what the ledger tracks; the local connector PID is owned but un-reapable in that sense). Resume-mode includes it (resume spawns a real new process owned by this plugin instance and IS in scope for orphan tracking).
- **Cancel-from-connect identity gate**: when `cancelTaskById` runs against a connect-origin task, re-call `getPidIdentity(task.pid)` and compare against the captured `task.psIdentity` BEFORE invoking `killProcessTree`. On mismatch, log a warning and skip kill (defense against connector PID being reused by the OS). This is wired into `cancel-helper.ts` in Unit 2 (signature already accommodates origin branching).

**Execution note:** Test-first for the tool factories using the existing fake-binary pattern from `tests/tools.test.ts`. Validation helpers from Unit 3b already covered; here we only test wiring + argv assembly + pre-flight gating + happy/sad paths.

**Patterns to follow:**
- `src/tools/delegate.ts` for tool factory shape, argv assembly, `appendRepeatedFlag`, registry write.
- `src/runtime/cancel-helper.ts` for the shared-helper pattern called by both tool and RPC route.
- `tests/tools.test.ts` fake-binary approach for the new tests.
- `getPidIdentity` from `src/runtime/orphan-reaper.ts` for the connect identity capture.

**Test scenarios:**
- Happy path (resume): target = known plugin task's `copilotSessionId`; tool reuses captured `addDirs`, spawns `copilot --resume=<id> --add-dir <dir1> ...`, returns `{ task_id }`. — resume
- Happy path (resume): target = raw UUID with local session-state present; spawns and returns task handle. — resume
- Error path (resume): target = valid UUID with no local `session.db`; returns `{ error: "No local session found for UUID <id>" }` without spawning. — resume
- Error path (resume): target = unknown name (CLI exits 1 with stderr no-match); tool returns `{ error: "Session not found: '<value>'" }`. — resume
- Edge case (resume): target = name shorter than 7 chars; CLI rejects same way; same normalized error. — resume
- Happy path (connect): target = real session ID; spawn succeeds; `result.sessionId === target`; task created with `origin: 'connect'`, no orphan ledger entry. — connect
- Error path (connect): target = unknown ID; spawn succeeds but `result.sessionId !== target`; tool surfaces `{ error: "remote session '<id>' not found; new session started instead" }` and the spurious task is cleaned up. — connect
- Happy path (connect): captured `psIdentity` is non-empty after attach. — connect
- Integration: cancel on a `connect`-origin task returns `{ disconnected: true, was_running: true }` (relies on Unit 2). — tools
- Integration: tool catalog assertion in `tests/tools.test.ts` lists all 5 tools. — tools
- Integration: schema-walk case set in `tests/tools.test.ts` exercises resume/connect args (catches forgotten `normalizeToolArgSchemas` regression). — tools
- Happy path: `hasLocalSession(<uuid>)` returns true when `session.db` exists, false when the directory or file is absent. — session-store
- Edge case: `hasLocalSession` with non-UUID input returns false without throwing. — session-store
- Happy path: `normalizeContinuityError` matches the no-match stderr pattern and returns the cleaned message. — continuity-errors
- Edge case: `normalizeContinuityError` returns null for stderr it does not recognize. — continuity-errors

**Verification:**
- 5 tools registered; tool catalog test passes.
- All schema-walk cases pass after extension.
- Connect-mode tasks do not create an entry in the orphan PID ledger; verified by checking `orphans/` directory contents in the connect happy-path test.
- Resume-mode tasks DO create an orphan-ledger entry (regression check that resume keeps the existing spawn ownership behavior).

---

- [ ] **Unit 4: RPC contract + server routes + client methods**

**Goal:** Extend the RPC contract with `/tasks/resume`, `/tasks/connect`, and `/tasks/recent-sessions` endpoints. Each route validates inputs through the helpers from Unit 3b before dispatching.

**Requirements:** R12, R14

**Dependencies:** Unit 3c (the route handlers call `launchResume` / `launchConnect`).

**Files:**
- Modify: `src/runtime/rpc-contract.ts`
- Modify: `src/runtime/rpc-server.ts`
- Modify: `src/tui/rpc-client.ts`
- Test: `tests/rpc-server.test.ts`
- Test: `src/tui/__tests__/rpc-client.test.ts`

**Approach:**
- `rpc-contract.ts`: add three schema pairs.
  - `TasksResumeRequestSchema`: `{ targetId: string (length 1–128), cwd?: string (length ≤ 4096), addDirs?: string[] (max 32 entries, each length ≤ 4096), configDir?: string (length ≤ 4096) }`. Length caps come from input-validation primitives; full semantic validation lives in Unit 3b helpers, called inside the route handler.
  - `TasksConnectRequestSchema`: same shape minus `configDir` semantics specific to local resume (or include for symmetry; document the difference).
  - `TasksRecentSessionsRequestSchema`: `{ configDir?: string }`. Response: array of `{ uuid: string, mtime: number, projectName?: string, eventCount?: number }` sorted by mtime descending, capped at the most recent N (configurable; default 20). Read-only filesystem access.
  - All response schemas are discriminated unions with `{ error: string }`.
- `rpc-server.ts`: register `POST /tasks/resume`, `POST /tasks/connect`, `POST /tasks/recent-sessions` handlers in `handleRpcRequest`. Each handler:
  - Authenticates via the existing `isAuthorized` Bearer-token gate.
  - Parses + validates the body via existing `parseValidatedJsonBody` + `validateBody` helpers.
  - Runs the input-validation primitives from Unit 3b (`validateTargetId`, `validateAddDirs`, `validateCwd`) and returns `{ error }` on validation failure.
  - Calls `launchResume` / `launchConnect` / a new `listRecentSessions` runtime helper.
  - Wraps the whole body in a top-level `try/catch` that returns a structured 500 (per two-entrypoint hardening learning).
- **Per-session launch quota**: add a token-bucket-style counter to `rpc-server.ts` capping concurrent launches at 5 and total launches at 20-per-minute per session. Implement as a small in-memory limiter inside the file (no new module). Returns `{ error: 'launch quota exceeded; retry in <ms>' }` when over the cap.
- `rpc-client.ts`: add `tasksResume(input)`, `tasksConnect(input)`, `tasksRecentSessions(input)` methods using the existing `request({ ... })` wrapper (per-request timeout + dispose composition already there).

**Patterns to follow:**
- Existing `tasksCancel` round-trip in `rpc-contract.ts` / `rpc-server.ts` / `rpc-client.ts`.
- `parseValidatedJsonBody` and `validateBody` helpers in `rpc-server.ts` for input validation.
- Top-level `try/catch → structured 500` guard already in `handleRpcRequest`.

**Test scenarios:**
- Happy path: `POST /tasks/resume` with a valid payload returns 200 with `{ taskId }`. — rpc-server
- Error path: `POST /tasks/resume` with a malformed payload returns 400 with structured Zod errors. — rpc-server
- Error path: `POST /tasks/resume` with a path-traversal-shaped `targetId` returns 200 with `{ error: 'invalid target ID format' }` (validation primitive rejects). — rpc-server
- Error path: `POST /tasks/resume` with an `addDirs` entry beginning with `--` returns 200 with `{ error: 'argv-injection-shaped value in addDirs' }`. — rpc-server
- Error path: `POST /tasks/resume` with an `addDirs` entry outside allowed roots returns 200 with `{ error: 'path outside allowed roots' }`. — rpc-server
- Error path: `POST /tasks/resume` where `launchResume` returns `{ error }` returns 200 with the structured error body (NOT a 500 — the launcher's own error path is a normal response). — rpc-server
- Error path: `POST /tasks/resume` where the launcher throws is caught by the top-level guard and returns a structured 500. — rpc-server
- Auth: `POST /tasks/resume` without a Bearer token returns 401 (existing `isAuthorized` gate covers this). — rpc-server
- Quota: 6th concurrent launch in a session returns 200 with `{ error: 'launch quota exceeded; retry in <ms>' }`. — rpc-server
- Quota: 21st launch in 60s in a session returns the same quota error. — rpc-server
- Symmetric: parallel cases for `/tasks/connect`. — rpc-server
- Happy path: `POST /tasks/recent-sessions` returns array of session entries sorted by mtime descending. — rpc-server
- Edge case: `POST /tasks/recent-sessions` with non-existent configDir returns empty array (not error). — rpc-server
- Client: `tasksResume({ targetId })` round-trips to a stubbed server and returns the response body. — rpc-client
- Client: `tasksResume` request honors the existing per-request timeout. — rpc-client
- Client: `tasksRecentSessions` round-trips to a stubbed server. — rpc-client

**Verification:**
- New routes appear in the route table and respond to authorized requests.
- Schema validation rejects malformed bodies before they reach the launcher.
- All existing RPC tests stay green.

---

- [ ] **Unit 5: TUI affordances — Recent Sessions view + raw-ID input form**

**Goal:** Recovery-first TUI: a `Recent Sessions` view inside `/copilot-status` reads Copilot CLI's own session-state directory and offers selectable rows for resume; a raw-ID input form is the fallback for resume-of-unlisted-sessions and the primary for connect.

**Requirements:** R7, R8, R12, R13, R14, R15 (and product-lens F1: recovery-must-actually-work)

**Dependencies:** Unit 4 (the form/list submit via the new RPC routes).

**Files:**
- Modify: `src/tui/components/modal-list.tsx` (add focus model, action band; current modal has no focus management)
- Create: `src/tui/components/recent-sessions-view.tsx` (new dialog body)
- Create: `src/tui/components/raw-id-input.tsx` (new dialog body — minimal one-input form)
- Modify: `src/tui/components/confirm-card.tsx` (origin-aware copy for connect rows)
- Modify: `src/tui/index.tsx` (orchestration; add `/tasks/recent-sessions` RPC client wiring)
- Test: `src/tui/__tests__/modal-list.test.tsx` (extend existing file)
- Test: `src/tui/__tests__/recent-sessions-view.test.tsx`
- Test: `src/tui/__tests__/raw-id-input.test.tsx`
- Test: `src/tui/__tests__/confirm-card.test.tsx` (extend for connect copy)
- Test: `src/tui/__tests__/index.test.ts` (extend existing fetch-stub end-to-end coverage for the new flows)

**Approach:**
- **Footer keyboard hints**: extend modal-list footer from `Esc close` to `Esc close · R Resume · C Connect`. Single convention across all surfaces: footer hints carry keyboard shortcuts; inline buttons carry verb labels. No mixed conventions.
- **Focus model in modal-list**: rows take focus first (vertical list nav with up/down); from-rows the user can press R or C to jump to actions; from-actions the user navigates left/right between actions; Tab not used (TUI minimalism). Implements the focus model from scratch since modal-list currently has none. Reuses `useRenderer().keyInput` pattern from confirm-card.
- **Recent Sessions view** (resume primary):
  - Triggered by R from modal-list, or by Enter on a connect-origin row in the rows list (resume-from-row, R3 path).
  - Backed by a new RPC route `POST /tasks/recent-sessions` (added in Unit 4) that returns the `${configDir ?? ~/.copilot}/session-state/` directory listing sorted by mtime, plus best-effort metadata (project name from `events.jsonl` first user message, tool-call count from event count). Read-only; no plugin-side cache.
  - Renders selectable rows (max ~10 most recent); each row shows session ID short prefix, mtime relative, project name. User picks a row → `tasksResume({ targetId: <full-uuid>, configDir: <resolved> })`. On success, dialog replaces back to modal-list (the resumed task is now in the active list).
  - Empty state (no recent sessions found): show "No local Copilot sessions found in `<configDir>`. Press `I` to enter a session ID manually."
  - Below the row list, footer entry: `I Resume by ID` for sessions not in the recent list.
- **Raw-ID input form** (`raw-id-input.tsx`):
  - **Single input row only** (raw ID). No `cwd` / `addDirs` inputs in the TUI form for this slice. Workspace customization is exposed via the tool path (`copilot_resume` / `copilot_connect` tool calls) for power users; the TUI launches use current `directory` + the known-task pre-fill path (R6) when applicable.
  - Action row: `[Launch]` and `[Cancel]` buttons. Footer: `Enter launch · Esc cancel`.
  - Reused for both resume-by-ID (entered from Recent Sessions view via `I`) and connect-by-ID (entered from modal-list via `C`). The form's title and Launch behavior depend on which mode it was opened in.
- **State matrix**: per surface, explicit states are: idle, validating (sync, sub-ms), submitting (RPC in flight — Launch button disabled, footer shows `Launching…`), submit-error (error message rendered above input; input value preserved; cursor returns to input; user can edit and retry), network-error (same shape as submit-error), dismissed-mid-flight (request token + disposed guards prevent state mutation after unmount).
- **Confirm-card origin-aware copy**: `confirm-card.tsx` accepts an `origin` prop. For `'connect'`, renders `Disconnect from session?` / `[Disconnect]` / `[Stay Connected]`. For `'spawn' | 'resume'`, renders existing `Cancel Copilot delegation?` / `[Cancel Task]` / `[Keep Running]`.
- **Dialog swap discipline**: every transition uses `api.ui.dialog.replace`, never `clear()` + `replace()`. On modal-list → Recent Sessions: replace within the same host dialog instance.
- **Request-token + disposed guards** on every component that mutates state after RPC response: check `disposed || requestId !== currentRequestId` before writing (per two-entrypoint hardening learning).

**Execution note:** Implement components in isolation with stubbed RPC clients; wire to real clients only after each component's keyboard + focus + submit + error states pass tests independently. Implement the focus model in modal-list as a discrete first sub-step (separate commit if useful) before adding the Recent Sessions / raw-ID flows on top.

**Patterns to follow:**
- `confirm-card.tsx` for focus ring, keyboard handling, `onMouseUp` patterns, `KeyEvent` matching helpers.
- `modal-list.tsx` existing layout primitives (`<box>`, `<text>`, `BoxRenderable` typed refs).
- `api.ui.dialog.replace(() => <Component />)` swap pattern from `tui/index.tsx`.
- `InputRenderable` from `@opentui/core` for the single-input form (paste handling settled empirically; document any quirks).

**Test scenarios:**
- Happy path: pressing `R` from modal-list opens the Recent Sessions view; pressing `C` opens the raw-ID input form in connect mode. — index
- Happy path: Recent Sessions view renders rows from `tasksRecentSessions` response sorted by mtime descending. — recent-sessions
- Happy path: selecting a Recent Sessions row submits `tasksResume({ targetId: <full-uuid> })` and replaces back to modal-list on success. — recent-sessions
- Edge case: Recent Sessions view with empty response renders "No local Copilot sessions found in `<configDir>`" and offers raw-ID entry via `I`. — recent-sessions
- Happy path: raw-ID input form submits to `tasksResume` (or `tasksConnect`) with only `targetId`; payload omits `cwd` and `addDirs` (TUI launches use the active `directory`). — raw-id-input
- Error path: RPC returns `{ error }`; form renders the error message above input; input value preserved; cursor returns to input. — raw-id-input
- Error path: RPC rejects (network/timeout); form renders a generic error message; component is not torn down. — raw-id-input
- Edge case: form unmounted (Esc) mid-RPC; late RPC response does not mutate state (request-token guard). — raw-id-input
- Edge case: form Launch button disabled while submitting; footer shows `Launching…`. — raw-id-input
- Integration: the host dialog is never `clear()`-then-`replace()`-d during transitions modal-list ↔ Recent Sessions ↔ raw-ID input (regression against the re-entrant dialog freeze). — index
- Integration: cancel-from-row on a connect-origin task renders the Disconnect confirm card variant. — confirm-card
- Integration: cancel-from-row on a resume-origin task renders the existing Cancel confirm card variant (regression). — confirm-card
- Integration: focus model navigates rows (up/down), jumps to actions on R/C, navigates actions (left/right), wraps within each region but does not cross. — modal-list

**Verification:**
- New affordances visible in the modal; keyboard shortcut + click both work.
- Form roundtrips through both new RPC routes successfully.
- No regression on existing modal flows (cancel, list display, refresh).

---

- [ ] **Unit 6: AGENTS.md, README, output tool description, and changeset**

**Goal:** Document the new tools, RPC routes, origin discriminator, borrowed-session rule, and elevated RPC token authority. Add a `minor` changeset.

**Requirements:** R8 (user-facing distinction partly lives in docs)

**Dependencies:** Units 1-5 functionally complete.

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `src/tools/output.ts` (extend tool description to mention `origin` field and the connect-disconnect / user-cancel asymmetry)
- Create: `.changeset/<slug>.md` (`minor` bump)

**Approach:**
- `AGENTS.md`: update "What This Project Is" section to list 5 tools (3 → 5). Add a new "Borrowed sessions" subsection under Design Decisions describing the connect-mode rule (local connector PID owned, remote session borrowed, no orphan ledger entry for connect, `disconnected` cancel response, captured `psIdentity` for safety, identity gate before destructive action). Add a "RPC token authority" subsection noting that after this slice, the port-file Bearer token grants subprocess-spawn authority bounded by input validation + per-session launch quota; same-UID local-attacker model unchanged but impact-of-compromise grows. Update the architecture tree to list `src/tools/resume.ts`, `src/tools/connect.ts`, `src/runtime/continuity-checks.ts`, `src/runtime/continuity-validation.ts`, `src/tui/components/recent-sessions-view.tsx`, `src/tui/components/raw-id-input.tsx`. Note: `notify.ts` in-flight-counter discipline behaves identically across all origins (no per-origin counter changes).
- `README.md`: add a "Resume and connect" section describing the two new tools, the Recent Sessions view, raw-ID input fallback, and the after-restart raw-ID contract (no plugin-side catalog; Recent Sessions view reads Copilot CLI's own state). Document the connect silent-fallback gotcha ("invalid IDs may silently start a fresh session in your repo") prominently.
- `output.ts` description: add a paragraph explaining that for connect-origin tasks, `status` will be `'cancelled'` on disconnect with `origin: 'connect'` carrying the truth; consumers wanting to distinguish should branch on `origin`, not `status`.
- Changeset: `minor` bump per the 0.x-series rule. Body: resume + connect tools, Recent Sessions view, restart-survivable raw-ID lookup, borrowed-session rule, security-validated input contracts, R9 version-conditional disclaimer.

**Execution note:** none — pure documentation pass.

**Test scenarios:**
- Test expectation: none — pure documentation pass with no executable behavior.

**Patterns to follow:**
- Existing AGENTS.md structure and tone.
- Existing changeset bodies for feature additions (e.g., the v0.7.0+ ones).

**Verification:**
- Lint passes on the changeset.
- AGENTS.md tree matches the actual `src/` layout after the implementation lands.

## System-Wide Impact

- **Interaction graph:** Two new tool factories register through the same `normalizeToolArgSchemas` + `plugInOnce` pipeline as the existing three. Two new RPC routes follow the same auth + Zod-validation + structured-error chain as the existing three. New TUI form follows the same dialog-swap idiom as the existing modal-list / confirm-card. No new architectural seams.
- **Error propagation:** `launchResume` / `launchConnect` return `{ error }` shapes; both the tool execute paths and the RPC route handlers relay them through. The top-level RPC try/catch only fires on truly unexpected throws; expected error states (no-match, no-local-session, connect-mismatch) are normal responses.
- **State lifecycle risks:** Connect-mode tasks introduce a borrowed-process lifecycle the registry has not modeled before. Mitigated by treating them as un-reapable (no orphan-ledger write) and capturing `psIdentity` for any future destructive action's identity gate. Resume-mode tasks are functionally equivalent to spawn (real new local process); only the launch argv differs.
- **API surface parity:** Output envelope and notify text both branch on `origin`. Cancel response branches on `origin`. Tool catalog grows from 3 to 5 (visible to any agent inspecting `client.tool.list({ provider, model })`). No changes to existing tool signatures.
- **Integration coverage:** Cancel-from-connect, schema-walk over all 5 tools, and the TUI form-RPC roundtrip all need integration-flavored tests that mocks alone won't prove. Listed explicitly in the per-unit test scenarios.
- **Unchanged invariants:** The orphan reaper's PID-file ledger contract is unchanged for spawned and resumed tasks (resume-mode tasks still write entries; the reaper's spawner-liveness gate still applies). The terminal-state set in `task-status.ts` is unchanged (no new `disconnected` status — origin field carries the truth). `setStatus` remains the single terminal-write entry.

## Security & Input Validation

The new RPC routes accept user-supplied target IDs and workspace paths and forward them into a Copilot CLI subprocess. The existing port-file Bearer-token auth model already gates same-UID local access, but after this slice the same token grants subprocess-spawn authority — a strict superset of the prior list-and-cancel scope. Input validation is therefore mandatory, not optional.

**Input contracts (all enforced in `src/runtime/continuity-validation.ts`, called by both tool factories and RPC routes):**

| Input | Validation | Failure mode |
|---|---|---|
| `targetId` | Discriminated union: UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) OR safe-name (`/^[A-Za-z0-9._-]{1,128}$/`). Length capped at 128. | Return `{ error: 'invalid target ID format' }` without spawning. |
| `cwd` | Must be absolute path; must not begin with `--`; must `path.resolve` under one of `allowedRoots` (active workspace + `directory` plugin option, by default). | Return `{ error: 'cwd outside allowed roots' }` without spawning. |
| `addDirs` | Per entry: must be absolute path; must not begin with `--`; must `path.resolve` under one of `allowedRoots`. Array length capped at 32. | Return `{ error: 'argv-injection-shaped value in addDirs' }` or `{ error: 'path outside allowed roots' }` without spawning. |
| `configDir` | If provided: must be absolute path; must `path.resolve` under user home directory or an explicitly-allowed override list. | Return `{ error: 'configDir outside allowed roots' }` without spawning. |

**`psIdentity` capture timing**: at spawn time (synchronously with PID assignment in `subprocess.ts`), NOT after the first JSONL event. Captured `psIdentity` is verified before any later destructive action (cancel of connect-origin task) by re-calling `getPidIdentity(task.pid)` and comparing. Mismatch → log warning, skip kill, still transition to terminal state.

**Threat model under same-UID local-attacker assumption (unchanged from existing model):**
- An attacker reading the port file at `~/.cache/opencode/copilot-delegate/<session>/server-port.json` can POST to the RPC routes. Before this slice, that gave them list-and-cancel authority; after this slice, that gives them spawn-arbitrary-Copilot-subprocess authority bounded by the input validation contracts above and the per-session launch quota.
- The port file is created mode `0o600` in a directory mode `0o700`; existing posture is correct. This slice does not change file permissions but documents the elevated authority of the token in `AGENTS.md` (Unit 6).
- Per-session launch quota (5 concurrent, 20-per-minute) caps the blast radius of a compromised token even within the validated input contract.

**R9 is empirical-version-conditional, not a universal contract**: structured error normalization (stderr regex, pre-flight stat, post-spawn validation) is verified against Copilot CLI 1.0.40. A runtime canary on plugin init logs a warning when `copilot --version` differs. The plan does not claim R9 holds across all Copilot CLI versions — if upstream changes the error wording or the on-disk session-state layout, normalization may degrade to passthrough until updated.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Copilot CLI changes `--resume` / `--connect` argv shape, error text, or session-state filesystem layout between 1.0.40 and a future version | Pin Copilot CLI in `mise.toml` (already done); plugin init logs a runtime canary warning when `copilot --version` differs from tested 1.0.40; document R9 as version-conditional in tool descriptions and AGENTS.md; CI regression test exercises the empirical fixture as a leading indicator. |
| `--connect` silent-fallback (CLI silently starts fresh session against unknown ID) does damage before any plugin-side validation can fire | Empirical-first design: Unit 3a captures real connect JSONL and identifies whether any early identity event exists; if not, ship with loud warning in tool description + spawn toast ("invalid IDs may silently start a fresh session"); do not claim attach-time validation we cannot deliver. |
| Connect-origin task cancel kills the wrong process if connector PID is OS-reused | `psIdentity` captured at spawn time; `getPidIdentity()` verifies before kill; mismatch logs warning and skips kill; task still transitions to terminal state. Residual risk: `lstart` is wall-clock-second granular; same-second PID reuse with same `comm` would pass the gate (extremely rare on a busy system; documented). |
| Recursive Copilot sessions: a resumed session internally spawns child copilot processes (via MCP, hooks, subagents) that escape the origin model and orphan-ledger tracking | Out of scope for this slice; documented as a known gap in AGENTS.md and tracked as a follow-up open question. Resume-mode orphan tracking only covers the directly-spawned PID. |
| External consumers reading `status: 'cancelled'` cannot distinguish user-cancel from connect-disconnect | Tool description for `copilot_output` updated to mention the `origin` field and the asymmetry (Unit 6). External consumers (`output.ts`) keep the existing status surface; no new `disconnected` status. Acceptable cost given the simpler internal type system. |
| TUI form regressions re-introduce the re-entrant dialog freeze | Explicit integration test asserts no `clear()`-then-`replace()` sequence in the new code paths; PR review verifies by inspection. |
| The known-task lookup (R3) misleads users into thinking a resumed session shares state with the known task even after restart | Documentation in README and tool descriptions makes the after-restart raw-ID contract explicit (no plugin-side catalog persists across restarts; recovery relies on the upstream Copilot CLI session storage AND the Recent Sessions view, which is a *view onto Copilot CLI's catalog*, not a plugin-owned one). |
| Recent Sessions view performs filesystem reads and `events.jsonl` parsing on every modal open, slowing modal load | Capped at N most recent (default 20); per-session metadata extraction is best-effort with a hard timeout; failures degrade gracefully (UUID + mtime only, no project name / event count). |

## Documentation / Operational Notes

- README and AGENTS.md updates land in Unit 6.
- No infrastructure changes (no new env vars, no new config).
- No CI changes (existing test runner picks up new test files automatically).
- Existing user-level plugin pin (`opencode-copilot-delegate@0.10.1`) updates after release; the new release is a `minor` bump on the 0.x series (next published version determined by the version-packages PR).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-02-copilot-session-continuity-requirements.md](../brainstorms/2026-05-02-copilot-session-continuity-requirements.md)
- **Capabilities research:** [docs/research/copilot-cli-capabilities-2026-04-27.md](../research/copilot-cli-capabilities-2026-04-27.md) (§1, §10.12, §11)
- **Ideation seed:** [docs/ideation/2026-04-27-copilot-delegate-v0.2.md](../ideation/2026-04-27-copilot-delegate-v0.2.md) (S2 entry)
- **Sibling brainstorm:** [docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md](../brainstorms/2026-04-27-copilot-status-tui-requirements.md) (S1 visibility platform — composes with this slice)
- **Institutional learnings:**
  - [docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md](../solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md)
  - [docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md](../solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md)
  - [docs/solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md](../solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md)
  - [docs/solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md](../solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md)
  - [docs/solutions/best-practices/secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md](../solutions/best-practices/secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md)
- **Empirical Copilot CLI failure-mode catalog:** captured this session via `copilot_delegate` against CLI 1.0.40; folded into Key Technical Decisions and Open Questions.
