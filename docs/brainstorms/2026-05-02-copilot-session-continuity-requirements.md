---
title: Copilot session continuity requirements
date: 2026-05-02
status: ready-for-review
scope: deep
topic: copilot-session-continuity
ideation_source: docs/ideation/2026-04-27-copilot-delegate-v0.2.md (S2)
related:
  - docs/research/copilot-cli-capabilities-2026-04-27.md
  - docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md
handoff: ce:plan
---

# Copilot session continuity requirements

## Summary

Ship S2 as a continuity layer for prior Copilot sessions: users can resume interrupted work and connect to still-running sessions through dedicated tools and `/copilot-status`. The first slice optimizes for continuity and recovery, not ACP, while treating raw Copilot session identities as first-class so explicit-ID flows still work after restart. Fork is explicitly deferred to a follow-up slice.

---

## Problem Frame

The current plugin is strong at spawning and monitoring new delegations, but weak at picking useful work back up once it leaves the happy path. A promising delegation that times out, loses its parent session, or needs to be continued elsewhere forces the user back into raw Copilot CLI knowledge and manual reconstruction of context. S1 improved in-flight visibility, but it intentionally stopped short of continuity.

This is not just a convenience gap. The Copilot CLI already exposes continuity primitives such as `--resume` and `--connect`, but they are easy to misuse from the plugin surface because session targeting, workspace re-application, and failure handling are not yet productized. In particular, resume does not preserve process-local path access automatically, so a continuity feature that does not restore workspace context would look like continuity while quietly dropping capability.

---

## Actors

- A1. OpenCode user: launches, recovers, or attaches to Copilot sessions.
- A2. Server plugin runtime: translates continuity intent into safe Copilot CLI invocations and task tracking.
- A3. `/copilot-status` TUI: launches continuity actions and shows resulting live state.
- A4. Copilot CLI session: the underlying session identity and execution context being resumed or connected to.

---

## Key Flows

- F1. Resume an interrupted session
  - **Trigger:** A1 chooses resume from a tool call or `/copilot-status`.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** A1 selects or provides a target session identity. A2 resolves whether the plugin knows prior workspace metadata for that session. If metadata exists, A2 re-applies it automatically. If it does not, A2 requires the missing workspace inputs explicitly. A2 launches the continuity action and returns a new trackable task handle. A3 shows the resulting live state.
  - **Outcome:** The prior Copilot session continues through the current plugin process without the user rebuilding context from scratch.
  - **Covered by:** R1, R2, R4, R5, R6, R9, R10, R11, R14

- F2. Connect to a still-running session
  - **Trigger:** A1 chooses connect from a tool call or `/copilot-status`.
  - **Actors:** A1, A2, A3, A4
  - **Steps:** A1 targets a running Copilot session by plugin-known record or raw Copilot identity. A2 validates the target and resolves whether prior workspace metadata is available. If metadata exists, A2 re-applies it automatically. If it does not, A2 requires the missing workspace inputs explicitly before connect continues. The resulting attachment is surfaced as a live, controllable item in the current plugin process.
  - **Outcome:** A1 can attach to in-flight work without spawning a fresh unrelated delegation.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R9, R10, R12, R14

---

## Requirements

**Continuity model**
- R1. The first S2 slice must treat resume and connect as first-class continuity actions rather than as hidden flags on fresh delegation.
- R2. S2 must accept raw Copilot session identities as first-class targets for continuity actions, not only plugin `cpl_*` task IDs.
- R3. When the plugin already knows a matching local task or session record, the continuity flow should prefer that record as the default path while still allowing direct raw-ID targeting.
- R4. Resume and connect via explicit raw Copilot session identity must remain available after plugin or OpenCode restart. The plugin accepts user-provided raw Copilot session identities; it does not retain a plugin-owned session catalog across restarts. Recovery relies on the upstream Copilot CLI's own session storage, not on plugin-side persistence.
- R5. ACP is deferred from the first S2 slice; the requirements assume continuity is built on existing Copilot CLI session-targeting capabilities rather than a long-lived ACP server.

**Workspace continuity and safety**
- R6. When the plugin knows prior workspace metadata for a target session, continuity actions must re-apply that working context, including the prior `cwd` and any captured `--add-dir` set.
- R7. When the user targets a raw session identity that the plugin cannot map to prior workspace metadata, the flow must make that missing context explicit and require the user to supply the needed workspace inputs instead of silently continuing with partial access.
- R8. The product surface must distinguish resume and connect in user-facing copy and action labels so users do not need to infer Copilot semantics from raw CLI flags.
- R9. If a requested continuity action is invalid, unreachable, or incompatible with the target session, the plugin must fail with a structured, specific explanation rather than silently falling back to a fresh delegation.

**User-facing surfaces**
- R10. The first S2 slice must ship dedicated user-facing continuity tools rather than requiring callers to encode raw continuity flags through `copilot_delegate`.
- R11. Continuity actions must return a current-process plugin task handle so existing output, cancel, notification, and status flows continue to work against the resulting live action. Continuity-derived tasks share the existing `TaskState` shape, distinguished by an `origin: 'spawn' | 'resume' | 'connect'` discriminator; where the current process did not originate the underlying Copilot session, the registry treats borrowed-process state explicitly so cancel, output, and notify behave truthfully rather than silently no-op.
- R12. `/copilot-status` must act as an action launcher for continuity, not only as a passive status list.
- R13. `/copilot-status` must surface inline `Resume by ID` and `Connect by ID` affordances inside the existing modal so users can launch continuity for raw Copilot session identities that are not already present in the visible current-process list. No separate slash commands are required for the first slice.
- R14. Continuity actions launched from `/copilot-status` must produce a live result that is immediately visible and controllable through the existing status surface.

**Compatibility and slice discipline**
- R15. The first S2 slice must compose with the existing S1 TUI/status foundation rather than requiring a new always-visible panel or a separate continuity-specific UI surface.
- R16. The first S2 slice must work without introducing persistent plugin-owned task storage as a prerequisite.
- R17. The first S2 slice must not require transcript replay, watchdog behavior, or ACP-mediated long-lived sessions to deliver its continuity value.

---

## Acceptance Examples

- AE1. **Covers R2, R4, R10, R11.** Given OpenCode has restarted and the prior plugin process no longer has the old `cpl_*` task in memory, when the user invokes the resume tool with a valid raw Copilot session name or ID, the plugin still launches a continuity action and returns a new current-process task handle.
- AE2. **Covers R6, R7.** Given a session originally launched by the plugin with additional `--add-dir` access, when the user resumes that session through a known plugin record, the plugin re-applies the original workspace context automatically; when the user targets a raw session ID that has no known workspace metadata, the flow stops and asks for the missing workspace inputs instead of proceeding silently.
- AE3. **Covers R8, R12, R13, R14.** Given the user opens `/copilot-status`, when they choose a continuity action, the UI presents distinct resume and connect actions and offers inline `Resume by ID` and `Connect by ID` affordances for targeting a raw Copilot session identity that is not already in the current list.
- AE4. **Covers R9, R11.** Given the user targets a stale or invalid Copilot session identity, when they invoke resume or connect, the plugin returns a structured continuity-specific error rather than starting a fresh unrelated delegation.
- AE5. **Covers R5, R15, R17.** Given the first S2 slice ships, when the user exercises continuity from tools or `/copilot-status`, the flow works without requiring ACP mode, transcript replay, or a new non-status UI surface.

---

## Success Criteria

- A user can resume or connect to prior Copilot session context through plugin-native tools and `/copilot-status` without dropping to raw `copilot` CLI usage.
- A user with a valid explicit Copilot session identity can recover continuity after restart, even when the plugin no longer has prior in-memory task state.
- The requirements are specific enough that planning does not need to invent the first-slice product stance on ACP, restart behavior, raw ID exposure, or the role of `/copilot-status`.

---

## Scope Boundaries

### Deferred for later

- Fork from a prior session — UX-only branching that would internally call resume with a new prompt and an `origin: 'fork'` discriminator. Defer to a follow-up slice once resume + connect are shipping cleanly.
- ACP-mediated long-lived sessions and any ACP-backed default strategy.
- Persistent plugin-owned session or task storage across restarts.
- Transcript replay, export, or post-mortem browsing as part of continuity.
- Watchdog or stall-detection behavior.

### Outside this product's identity

- Replacing Copilot CLI's session model with a plugin-owned conversation store.
- Building a separate continuity dashboard or always-visible panel outside `/copilot-status`.
- Treating continuity as an implementation-only refactor with no user-facing tools or actions.

---

## Key Decisions

- Continuity first, ACP later: the first S2 slice optimizes for resume/connect rather than long-lived ACP sessions.
- Tools and TUI ship together: continuity is not tools-only and not TUI-only.
- Resume and connect ship together in the first slice; fork is deferred as a follow-up that internally calls resume with a new prompt and an `origin: 'fork'` discriminator.
- Raw Copilot session identities are first-class from day one, including explicit-ID flows after restart.
- `/copilot-status` is an action launcher for continuity, not just an observer.

---

## Dependencies / Assumptions

- Copilot CLI continues to support `--resume` and `--connect` semantics close enough to the current documented behavior in `docs/research/copilot-cli-capabilities-2026-04-27.md`.
- The plugin can capture and reuse enough prior launch metadata to restore workspace context for plugin-originated sessions.
- The existing S1 TUI foundation is the continuity launch surface for the first S2 slice.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R10, R11][Technical] What exact tool surface should expose continuity most cleanly: two dedicated tools (`copilot_resume`, `copilot_connect`) or a single `copilot_continuity` tool with an explicit action parameter?
- [Affects R6, R7][Technical] What is the smallest safe argument contract for user-supplied workspace context when the plugin has no prior metadata for a raw Copilot session identity?
- [Affects R9][Needs research] Which Copilot CLI failure modes for invalid, stale, or inaccessible session identities can be detected and normalized reliably from current stderr/stdout behavior?
