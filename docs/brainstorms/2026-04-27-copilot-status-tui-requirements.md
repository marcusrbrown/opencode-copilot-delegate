---
title: "/copilot-status TUI — visibility platform requirements"
date: 2026-04-27
status: ready-for-planning
scope: standard
ideation_source: docs/ideation/2026-04-27-copilot-delegate-v0.2.md (S1)
related:
  - docs/research/copilot-cli-capabilities-2026-04-27.md
  - docs/plans/2026-04-21-copilot-delegate-plugin.md (closed)
layout_reference:
  source: OpenCode native subagent view (observed during brainstorming; not checked into this repo)
  shape: |
    A vertically stacked panel layout, post-completion. Top: a header strip showing
    `Subagent (N of N)` indicating the run is finished. Below: a main prompt panel
    with a cyan / accent left border that holds the original delegated prompt.
    Below that: a vertical sequence of output cards — one per tool call — each
    collapsible with a `Click to expand` affordance on collapsed cards and showing
    the full tool result when expanded. Bottom: a status bar with delegation
    metadata on the left and navigation hints on the right reading
    `Parent up · Prev left · Next right`. Color treatment is OpenCode-default
    (cyan accent, default terminal foreground/background).
target_releases: v0.2.0 → v0.2.1 → v0.2.2 (staged; each minor bump per `0.x` policy)
handoff: ce:plan (v0.2.0 only); v0.2.1 and v0.2.2 each get their own brainstorm before planning
review_artifacts:
  - 5 of 6 reviewers returned (coherence-reviewer timed out); staging decision driven by HIGH consensus across scope-guardian, adversarial, and product-lens
---

# `/copilot-status` TUI — visibility platform requirements

## Problem

The v0.1.0 plugin makes long-running Copilot delegations possible but inconvenient to monitor. A 5-minute opus delegation looks identical to a hung subprocess from the parent OpenCode session: spawn returns a `task_id`, then nothing visible happens until the completion toast / system-reminder fires. The user *can* call `copilot_output` with blocking to inspect a running delegation, but that's a tool call away from the chat (and surfaces only the structured envelope, not a live event stream). Cancelling requires leaving the chat to call `copilot_cancel`. The v0.1.0 signature gap is **convenience and live progress**: no chat-native surface for in-flight inspection, no live tool-call rendering, no inline cancel control.

## Goal

Ship a chat-native delegation visibility surface across v0.2.0 → v0.2.2, mirroring how OpenCode renders subagent sessions, accessible via a single slash command, with cancel control and clear lifecycle signals. The architectural foundation lands in v0.2.0; richer rendering and history follow incrementally.

## Architectural commit (one-time, lands in v0.2.0)

The plugin becomes a **two-entrypoint package**: the existing server-side plugin (`src/index.ts` → `dist/index.js`) plus a new TUI plugin loaded from source at `src/tui/index.tsx` (per Magic Context's pattern, the TUI half is exposed via `package.json`'s `exports["./tui"]` pointing at the source file rather than a prebuilt bundle — OpenCode's TUI runtime compiles JSX/SolidJS through opentui at load time).

Matches the shape established by `@cortexkit/opencode-magic-context`. The two halves communicate over an RPC channel; the **proven precedent is HTTP over localhost** (Magic Context exposes a port file from the server-side plugin and the TUI makes direct HTTP RPC calls; a 500ms poller exists only for server→TUI notification messages, not for data fetching). Final transport choice is a `ce:plan` decision but HTTP is the default unless evidence to deviate emerges.

The TUI plugin is opt-in via the user's `tui.jsonc` (same opt-in posture as Magic Context). The server-side plugin continues to work without the TUI half installed — toasts and system-reminders still fire; the `/copilot-status` slash command degrades gracefully to a no-op message when the TUI half hasn't ack'd via RPC.

**Architectural commit is one-way**: once shipped, removing the TUI half breaks any user who added it to `tui.jsonc`. The strategic bet is that visibility unlocks downstream work (S2 resume/connect, S5 watchdog UI, S6 transcript replay) and the TUI surface is the right place for that. The alternative (server-side primitives only — enhanced toasts + a `/copilot-list` markdown command) was considered and rejected because it doesn't address live tool-call rendering and does not generalize to S2/S5/S6 follow-ups.

## Release staging

| Release    | What ships                                                                                          | Why this slice                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| **v0.2.0** | Foundation (TUI plugin half + RPC + build prerequisites + PID workaround) + list view + cancel + spawn toast | Ships the load-bearing architectural commit + minimum viable visibility (see what's running, kill it). |
| **v0.2.1** | Drilled fullscreen view with live event streaming                                                   | Solves "what is it doing right now?" Requires the foundation from v0.2.0 to be settled.            |
| **v0.2.2** | Recent-history (post-mortem), expandable output cards, concurrent ←/→ navigation                    | UX richness layered on top once core flow is validated.                                            |

This brainstorm scopes **v0.2.0 only** in detail. v0.2.1 and v0.2.2 get their own brainstorms when their time comes, informed by what v0.2.0 reveals.

## User scenarios (annotated by release)

1. **In-flight inspection (cancel only in v0.2.0; full live stream in v0.2.1).** User starts a long delegation, then types `/copilot-status` to see what it's doing. v0.2.0: modal opens with the delegation in the running list (status, model, agent, elapsed, tool-call count). v0.2.1: user drills into the delegation and watches tool calls / reasoning / file edits stream in real time, then returns to the list. (Specific drill-in / back-out keybinds are a v0.2.1 brainstorm decision — see preview below.)
2. **Cancel a stuck task (v0.2.0).** User notices in the modal that a delegation has been on the same tool call for several minutes (visible from the live tool-call count not advancing). Presses `c` on the focused row, confirms cancel. Modal updates the row status to `cancelling` then `cancelled`. Existing system-reminder fires in the parent session.
3. **Post-mortem (v0.2.2).** User wants to understand why a delegation just failed. Opens `/copilot-status`, sees the failed delegation in the recent-history section, drills in, scrolls through the captured event stream to find the failure point.
4. **Concurrent monitoring (v0.2.2).** User has two delegations running in parallel. Modal lists both with status, model, agent, elapsed (this works in v0.2.0). User uses ←/→ in the drilled view to flip between their event streams (v0.2.2).

## Non-goals (cross-release)

- **Persistent task storage across plugin reloads.** In-memory only across all v0.2.x; persistence is a v0.3+ topic when paired with resume/connect.
- **Sidebar / always-visible panel.** Modal-only across v0.2.x.
- **Resume / connect / fork delegations** (ideation S2).
- **Subprocess lifetime watchdog / stall detection** (ideation S5).
- **Transcript export / replay of completed delegations** (ideation S6).
- **Per-tool-call mid-flight toasts.** Live progress lives in the modal (v0.2.1+), not in toast spam.
- **Slash commands beyond `/copilot-status`.** Cancel and navigation via keybinds only.
- **`copilot_doctor` / diagnostics** (ideation S7).
- **`--ask_user` interactive relay.** Inverts the unattended-delegation value prop (ideation rejected).

## v0.2.0 — functional requirements

### Slash command

- **`/copilot-status`** — opens the modal at the list view. No arguments in v0.2.0.

The slash command is registered server-side (same pattern as Magic Context's `/ctx-status`). When the TUI plugin is loaded, the slash invocation triggers an RPC dialog request rather than emitting a `sendIgnoredMessage`.

### Modal — list view

- **Header**: `<n> running · <m> recent` (recent count is always 0 in v0.2.0; field reserved for v0.2.2).
- **List rows** (one per delegation), most-recent first, sorted by start time. v0.2.0 shows **running delegations only**:
  - Status badge: `running` (terminal statuses excluded from v0.2.0; they appear in v0.2.2 recent-history).
  - Task ID (`cpl_...`, abbreviated to first 8 chars after the prefix; full ID on focus).
  - Agent name (or `default`).
  - Model.
  - Elapsed time (live-updating).
  - Tool-call count (running total from `tool_calls_summary`).
- **Empty state**: see UX micro-specs.
- **Scroll behavior**: see UX micro-specs.

### Cancel flow (modal list)

Pressing `c` on a focused running delegation opens a confirm dialog (see UX micro-specs). After confirm, the existing `copilot_cancel` machinery is invoked via RPC. The row status transitions to `cancelling`, then `cancelled` once the subprocess actually dies and the existing system-reminder fires. After v0.2.0's terminal exclusion rule, the row then disappears from the list.

### Lifecycle notifications (v0.2.0 baseline; carries forward)

- **Spawn (NEW in v0.2.0)**: `client.tui.showToast({ message: 'Copilot delegation cpl_xxxxxxxx started', variant: 'info' })`. Triggered from `copilot_delegate` immediately after task creation succeeds.
- **Completion (existing, no change)**: `client.tui.showToast({ message: 'Copilot delegation cpl_xxxxxxxx completed', variant: 'success' | 'error' })` plus the existing system-reminder injection via `client.session.prompt({ noReply, parts: [...] })`.

The completion system-reminder remains unconditional — it's the LLM-orchestrator's signal to call `copilot_output`. Removing it would break the existing tool flow.

### Interaction model — v0.2.0 keybinds (modal list view only)

| Key       | Action                                              |
| --------- | --------------------------------------------------- |
| `↑` / `k`   | Move focus up                                       |
| `↓` / `j`   | Move focus down                                     |
| `c`         | Cancel focused running delegation (confirm dialog)  |
| `Esc`       | Close modal, return to OpenCode session             |

`Enter` (drill in), `r` (manual refresh), `←`/`→` (concurrent nav), `e`/`Space` (expand), `PgUp`/`PgDn` (scroll event stream) are deferred to v0.2.1 / v0.2.2 with the surfaces they belong to.

## v0.2.0 — UX micro-specs

These resolve the design-lens-reviewer findings for v0.2.0. Drilled-view + concurrent-nav UX are part of v0.2.1's brainstorm.

### Focus indicator (list view)

- Focused row: inverse video (`bg:accent fg:bg`).
- Running status badge: `●` prefix in accent color (cyan or theme-default), to distinguish a quietly-running task from a focused row.
- Unfocused rows: default terminal colors.

### Empty state

- Modal still shows the header (`0 running · 0 recent`).
- Body: vertically centered, two lines:
  - `No Copilot delegations are running.`
  - `Start one with the copilot_delegate tool, then reopen /copilot-status.`
- Footer hint: `Esc close`.

### Loading state (initial RPC round-trip after `/copilot-status` invocation)

- Header: `Loading delegations…` (single line, replaces the count line until the RPC responds).
- Body: empty.
- Auto-resolves to either populated list or empty state on first response.

### RPC error state (TUI plugin half installed but RPC unreachable)

- Header: `Status unavailable.`
- Body: vertically centered, two lines:
  - `The Copilot delegate TUI plugin is not responding.`
  - `Try reloading the plugin (or run /copilot-status again).`
- Footer hint: `Esc close`.

### Cancel-confirm dialog flow

- Dialog overlays the modal with ~60% dim of the underlying list (`api.ui.DialogConfirm`).
- Dialog text: `Cancel Copilot delegation cpl_xxxxxxxx?`
- Buttons:
  - Default focus: `Cancel Task` (destructive variant).
  - Secondary: `Keep Running`.
- After `Cancel Task` confirm: the row immediately shows `cancelling` (intermediate state); the actual `copilot_cancel` RPC fires; on completion the row goes to `cancelled` (then is removed from the v0.2.0 list per the running-only rule).
- After `Keep Running` confirm: dialog dismisses; modal returns to list view with focus retained.

### List scroll behavior

- Single-line rows.
- List is scrollable with `↑`/`↓`; focus wraps at top/bottom (no pagination, no virtualization needed at the 10-concurrent cap).
- Header and any future section dividers consume up to 4 lines; the rest of the modal is the scrollable list region.

## v0.2.1 — preview (out of scope for this brainstorm)

Drilled fullscreen view with live event streaming, mirroring OpenCode's native subagent shape (see frontmatter `layout_reference` for the captured static post-completion layout). Re-brainstormed when v0.2.0 is shipped and reviewed; that brainstorm will resolve:
- Drilled view layout for the *streaming* state (the captured reference is post-completion only).
- Arrow-key consistency between list view (`↑` = previous item) and drilled view (`↑` = parent up).
- Per-task event buffer caps (memory budget) for the focused delegation. (Pull-from-registry transport is already locked at prerequisite #4.)
- `Enter` (drill-in), back-out, and event-stream scroll keybinds.

## v0.2.2 — preview (out of scope for this brainstorm)

Recent-history surface, expandable output cards, concurrent ←/→ navigation in the drilled view. Re-brainstormed at its own time.

## Success criteria

### v0.2.0

**User-perceived value**:
- A user running `/copilot-status` while a delegation is in flight sees the delegation in the list within one RPC round-trip (≤250ms over localhost HTTP).
- A user can identify which of their running delegations is which (model, agent, elapsed, tool-call count) within 3 seconds of opening the list.

**Performance**:
- Pressing `c` on a running delegation, then confirming, results in the subprocess being killed within one second. The row visibly transitions to `cancelling` (intermediate state); once the subprocess actually dies and the existing system-reminder fires, the row reaches `cancelled` and is then removed from the list per the v0.2.0 running-only rule.

**Compatibility**:
- The plugin continues to work when the TUI plugin half is not installed: `copilot_delegate` / `copilot_output` / `copilot_cancel` and existing toasts/system-reminders continue. Only `/copilot-status` is unavailable.
- The plugin continues to work when the TUI plugin half is *installed but fails to load* (RPC unreachable, opentui mismatch, etc.): `/copilot-status` shows the spec'd RPC error state rather than throwing or blocking the session.
- After a plugin reload while delegations are running, the PID workaround (see prerequisite #3) reaps the orphaned subprocesses on plugin re-init before any RPC requests are served; the modal then accurately reflects the registry state (no stale "running" rows).

### v0.2.1 / v0.2.2

Captured in their respective future brainstorms.

## Prerequisites for `ce:plan` (v0.2.0; locked, not deferred)

These are blocking dependencies that must be resolved before implementation. Originally framed as open questions; review surfaced them as architectural constraints, not options.

1. **Build pipeline.** Add `@opentui/core` and `@opentui/solid` to `devDependencies` (peer deps of `@opencode-ai/plugin/tui`). Add JSX configuration to `tsconfig.json` (`jsx: "preserve"` + `jsxImportSource: "@opentui/solid"`, or per-file `/** @jsxImportSource @opentui/solid */` pragmas as Magic Context uses). The current build is `bun build` + `tsc --emitDeclarationOnly` — there is no `tsdown` in this repo and none is needed.
2. **`package.json` exports.** Add `exports["./tui"]` pointing at `./src/tui/index.tsx` (source, not built). The TUI half is loaded as TypeScript; OpenCode's TUI runtime handles compilation. Mirror Magic Context's `oc-plugin: ["server", "tui"]` field if/when OpenCode standardizes on it (currently a Magic Context convention, not an OpenCode-required field).
3. **PID-file workaround for plugin-reload orphans.** The `@opencode-ai/plugin` `Hooks` interface has no server-side dispose hook. v0.2.0 implements a workaround:
   - On plugin init, read PID file at `<XDG_STATE_HOME or ~/.local/state>/opencode-copilot-delegate/orphans.pids`.
   - For each PID still alive (POSIX `kill(pid, 0)`), invoke existing `killProcessTree(pid)` and log the reap.
   - On task spawn, append the subprocess PID to the file (atomic append with file lock).
   - On task terminal transition (`complete` / `failed` / `cancelled`), remove the PID from the file.
   - **Init bound**: the reap completes synchronously during plugin init *before* the RPC server begins accepting requests; at typical sizes (≤10 entries, the existing concurrent cap) the operation should complete in well under one second. The success criterion of "before any RPC requests are served" is structural (sequencing), not a wall-clock target.
   - Bounded scope; ~50 lines in `src/runtime/orphan-reaper.ts` plus an init call from `src/index.ts`.
4. **Push vs pull for events.** Architectural, not implementation. **Pull** — the TUI requests buffered events from the server-side registry on demand (per drilled-view focus, per RPC poll). Push from the JSONL parser into the RPC layer couples the parser to transport and creates backpressure risk. The server-side `task-registry` already buffers `events` in `SpawnCopilotResult`; expose a query method (e.g., `getTaskEvents(taskId, sinceEventId?)`). v0.2.0 only needs the *list* RPC method; the per-task event method lands with v0.2.1.

## Open questions for `ce:plan` (v0.2.0; genuinely deferable)

1. **Setup helper.** A `bunx opencode-copilot-delegate doctor` that auto-adds the plugin to `tui.jsonc` is nice-to-have; v0.2.0 documents the manual install path.
2. **Upstream lifecycle hook request.** Whether to file an upstream issue requesting a server-side `dispose` hook in `@opencode-ai/plugin`'s `Hooks` interface, to retire the PID workaround later. (Recommended yes, but doesn't block v0.2.0.)

## Risks (cross-release)

- **`@opencode-ai/plugin/tui` is undocumented beyond Magic Context.** API stability is uncertain; we're building on a single-consumer surface that may shift in ways not protected by semver. Mitigation: pin `@opencode-ai/plugin` to a known-good version; isolate TUI code so server-side keeps working if the TUI half breaks; document upgrade strategy in README.
- **Cancel races with JSONL parsing.** A cancel can arrive while the parser is mid-event; the subprocess kill may interleave with parser writes to the registry, leaving partial event data after `status === 'cancelled'`. Buffered stdout may also deliver post-kill JSONL lines. Mitigation: parser checks `status` before emitting events; once `cancelled`, parser drops further events and treats the existing buffer as final.
- **PID-file workaround edge cases.** PID reuse across reboots, files left behind by SIGKILL, races between concurrent plugin loads. Mitigation: include process start time alongside PID in the file and compare on reap to detect reuse. macOS (the primary dev env) has no `/proc`; use `ps -p <pid> -o lstart=` (or equivalent `node:child_process` invocation) to fetch the live process's start time and treat any mismatch as a reused PID. Always wrap reap in try/catch; treat the file as advisory not authoritative.
- **Auto-refresh render cost at concurrency cap (v0.2.1+).** 10 concurrent delegations × frequent RPC × reactive SolidJS re-render is unbudgeted. Mitigation in v0.2.1: spec event-buffer caps per task (e.g., last N events for non-focused tasks); only stream full events for the drilled-view focus.
- **JSX/SolidJS in a previously-pure-TS plugin.** Adds new build dimensions (JSX transform, opentui peer deps). Mitigation: see prerequisite #1; isolate TUI code under `src/tui/`; ensure `tsc --noEmit` handles `.tsx` correctly.
- **Modal interferes with active OpenCode work.** A modal taking over the screen while the user is mid-prompt is annoying. Mitigation: opening the modal does not block input to the underlying session; Esc returns instantly.

## Notes for `ce:plan` (v0.2.0)

- The two-entrypoint package layout is the largest single architectural decision the planner needs to lock in. Read `node_modules/@cortexkit/opencode-magic-context/packages/plugin/` for working precedent; specifically the HTTP RPC + port-file pattern.
- The list view's tool-call count column is `summary.tool_calls.length` from the envelope built in `src/runtime/envelope.ts` (the `summary` field on the result envelope holds a `tool_calls` array of `{ id, name, success }` entries). Verified at PR-time against `src/runtime/envelope.ts`; confirm again at implementation time in case the field shape evolves.
- `client.tui.showToast` is already wired via `src/runtime/notify.ts`. The spawn-toast addition is a one-line change there.
- Existing notification API (`client.session.prompt({ noReply, parts: [{ synthetic: true }] })`) does not change.
- Cancel from the TUI must invoke the server-side `cancelTask(taskId)` via RPC, which calls into the same `abortController.abort()` + `killProcessTree` chain the existing `copilot_cancel` tool uses. No new kill machinery.
- The PID workaround (prerequisite #3) is the only material new code surface outside `src/tui/`; it lives in `src/runtime/orphan-reaper.ts`.
- README update required at v0.2.0 implementation time: the existing `README.md` Known Limitations section lists "PID-file reaper" as "Planned for v1.x" — update that line to reflect the v0.2.0 commitment landing in this work.
