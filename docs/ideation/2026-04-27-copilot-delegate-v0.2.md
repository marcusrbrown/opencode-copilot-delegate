---
title: opencode-copilot-delegate v0.2.x — ideation
date: 2026-04-27
status: ranked
focus: |
  Two streams: (a) plugin features seeded by docs/research/copilot-cli-capabilities-2026-04-27.md;
  (b) TUI/desktop visibility for in-flight delegations — render JSONL event stream like an
  OpenCode subagent session, surfaced via slash commands like /copilot-status (cf. Magic
  Context's /ctx-status modal).
volume: default (~30 raw, ~22 deduped, 7 survivors)
frames: pain & friction · inversion/automation · assumption-breaking · leverage/compounding
handoff: ce:brainstorm on a single chosen survivor
related:
  - docs/research/copilot-cli-capabilities-2026-04-27.md
  - docs/plans/2026-04-21-copilot-delegate-plugin.md (closed, all T1–T11 ticked)
  - docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md
  - docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md
---

# v0.2.x Ideation — opencode-copilot-delegate

## Context

v0.1.0 shipped: three tools (`copilot_delegate`, `copilot_output`, `copilot_cancel`), JSONL
parsing, in-memory task registry, agent discovery, completion notifications. The plugin works
end-to-end (verified this session: 4076 events parsed across a 5m19s opus 4.7 delegation).

Two concrete signals shape v0.2.x:

1. The **research doc** (`docs/research/copilot-cli-capabilities-2026-04-27.md`) catalogs a
   12-pattern delegation playbook in §10 and 13 plugin-level limitations in §11. Most §10
   patterns require capabilities the plugin doesn't yet expose: ACP, `--resume`/`--connect`,
   `--share`, hooks, tool-permission templates.
2. The **TUI visibility focus** asks for the JSONL event stream to surface the way OpenCode
   renders a subagent session, with slash-command access (`/copilot-status` modeled on Magic
   Context's `/ctx-status`). No documented precedent in the OpenCode ecosystem — net-new
   territory; viability is part of what brainstorming will resolve.

The plugin itself is a small, focused TypeScript package (~1200 LOC source); the v0.2.x bar
is "compound investments that ripple into multiple shipped features," not "ship every flag."

## Survivors (7)

### S1. In-flight delegation visibility platform — `/copilot-status` modal + lifecycle toasts

**Bundle**: streaming event bus (parser hook) + event-sourced task registry + slash-command
TUI surface. The user-stated focus, expressed as a concrete deliverable.

- Live modal renders active and recent delegations as a subagent-style panel: live `tool_call`
  timeline, current model, elapsed time, status, agent. Ties into `tool_calls_summary` data
  the envelope already captures.
- `client.tui.showToast()` (defined but unused in v0.1) wired into spawn / complete / fail /
  timeout transitions. Cheap addition; no new APIs needed.
- Foundation: a typed event emitter on `jsonl-parser.ts` so live UI, audit log, and OTel are
  all subscribers on one bus.
- Foundation: append-only event log replacing the in-memory `Map` in `task-registry.ts` —
  unlocks resume, audit, cross-session visibility, and crash recovery from one primitive.

**Why this survives**: directly answers the explicit user focus; combines four frames; every
sub-investment compounds into multiple shipped features (status UI, audit, OTel, recovery).
No precedent in OpenCode is risk, but the `client.tui` surface already exists — the brainstorm
phase resolves the technical viability question with a small spike.

**Rejected alternatives folded in**: F1.4 toasts standalone, F4.5 toast-first notifications,
F4.7 slash-command surface, F1.7 in-flight tool-call timeline, F3.2/F3.8 native tool-call
rendering, F4.2 streaming event bus, F4.1 event-sourced registry, F4.9 audit log sidecar,
F3.6 cross-session pool. (Standalone they were thin; bundled they're the right v0.2 shape.)

---

### S2. `CopilotProcess` abstraction with `--acp` / `--resume` / `--connect` strategies

Refactor `subprocess.ts` into a `CopilotProcess` class that accepts a spawn strategy:
`direct` (today), `acp` (long-lived stdio server), `connect` (attach to existing session),
`resume` (continue prior session). The wrapper handles JSONL streaming, process-group
cleanup, and envelope building uniformly across strategies. New tools `copilot_resume` and
`copilot_connect` become trivial layers on top.

**Why this survives**: ACP is the most architecturally consequential capability the plugin
doesn't expose — persistent sessions cut per-call latency and cost (research doc §10.11).
Even shipped behind an opt-in flag, the abstraction itself unlocks resume + connect for free.
Once stable, ACP can become the default.

**Risks called out for brainstorm phase**: ACP is undocumented in `copilot help` (only
`--acp` flag listed); the protocol may be unstable. Mitigation: ship `direct` strategy as
default in v0.2.x, ACP as `experimental`; promote in v0.3.x.

**Rejected alternatives folded in**: F2.2 ACP server, F3.1 Copilot daemon, F4.8 ACP-as-default,
F1.3 resume/fork from UI, F2.3 delegate state to Copilot --resume IDs.

---

### S3. Permission profiles + agent manifest fusion

Named permission profiles (`read-only`, `refactor`, `audit`, `doc-gen`, `unsafe`) replace
hand-rolled `--allow-tool='shell(git:*),...'` strings on every call. Profiles compose with
discovered `.agent.md` frontmatter into a single "agent manifest" object that feeds three
surfaces: (a) tool description for the LLM, (b) pre-spawn validation that catches
typos/conflicts before subprocess cost, (c) a `/copilot-agents` picker in TUI.

**Why this survives**: research doc §10 prescribes per-pattern permission tuples; today every
caller hand-rolls them. Profiles + manifest are the canonical reusable form. Compounds with
S1's modal (manifest data → picker UX) and S4 below (manifest → tool registration).

**Rejected alternatives folded in**: F2.6 permission profiles, F4.4 manifest fusion.

---

### S4. Per-agent tool registration

At plugin load, discover all available Copilot agents (user `~/.copilot/agents/`, repo
`.github/agents/`, plugin-installed `~/.copilot/installed-plugins/*/agents/`) and register
each as a distinct OpenCode tool — `copilot_code_review`, `copilot_security_audit`, etc. —
each with a description derived from the agent's frontmatter. The generic `copilot_delegate`
remains as a fallback escape hatch.

**Why this survives**: makes Copilot agents first-class tools the LLM can pick by intent
rather than by passing an `agent` string. Pairs tightly with S3 (manifest → tool description).
Also fixes the latent bug surfaced this session: the plugin's hardcoded `BUILTIN_AGENTS` list
(`['default','explore','task','general-purpose','code-review','research']`) is wrong — Copilot
CLI v1.0.36 ships zero built-ins. Per-agent discovery + registration replaces that list with
empirical truth.

**Risks for brainstorm**: dynamic tool registration may need an OpenCode plugin API surface
the project hasn't validated yet; if registration is static-only, fall back to a single
`copilot_delegate` with `agent` as an enum derived at load time.

**Rejected alternatives folded in**: F3.4 agent-as-tool registry; closes KNOWN_ISSUE 1658.

---

### S5. Hung-task watchdog with lifetime timeout

Subprocess lifetime cap (configurable, default e.g. 15 min) + heartbeat-based stale detection
(no JSONL events for N seconds). On timeout: kill via existing `fkill(-pid)` path, set status
`timed_out`, surface a plain-English reason via the same notification surface (toast + system
reminder), and link the user to the offending task in `/copilot-status` (S1).

**Why this survives**: this is the cleanest fix to a documented `KNOWN_ISSUE` ("No subprocess
lifetime timeout — hung copilot stays 'running' forever; deferred to v1.x"). The "deferred to
v1.x" framing was set before TUI visibility became the focus; once S1 ships, watchdog signals
are first-class UI events rather than hidden state. Cheap to implement; pure quality
investment.

**Rejected alternatives folded in**: F1.2 watchdog standalone (now ties into S1's surface).

---

### S6. Transcript export + TUI replay

On completion, optionally pass `--share=<path>` so Copilot writes the full session transcript
to a known location. Add a `/copilot-replay <task_id>` command that renders the captured
transcript via the same subagent-session viewer used by S1's live mode. Same renderer; live
vs replay is the only difference.

**Why this survives**: piggybacks on S1's renderer with no additional UI investment.
Naturally answers the "what happened?" question after a delegation completes. Future-feeds
the "knowledge-compounding loop" (every transcript → optional `ce:compound` entry); v0.2.x
ships only the export + replay, not the loop.

**Rejected alternatives folded in**: F4.6 transcript export, F3.7 transcript ingestion (the
"inject as session messages" variant is more invasive; leave for v0.3+).

---

### S7. `/copilot-doctor` diagnostic command

Single command that validates the local Copilot CLI environment the plugin assumes:

- `copilot --version` matches the supported range (warn on drift; the JSONL parser is pinned
  to 1.0.36's schema).
- Auth token shape: detect classic `ghp_` PAT (silently rejected by Copilot) and warn with the
  fix.
- Agent discovery: list discovered agents and their sources; flag the BUILTIN_AGENTS regression
  if v0.1 is still installed somewhere.
- Active hooks: enumerate `~/.copilot/hooks/*` and `~/.copilot/settings.json:hooks` so users
  know hooks will fire for every plugin-spawned subprocess.
- JSONL contract sanity-check via a dry-run delegation that exercises the parser against
  current Copilot CLI output.

**Why this survives**: most of the silent failure modes documented in research doc §9 are
environmental — auto-update breaks parsers, stale tokens, classic PATs, hook double-billing.
A single command surfaces them before the user burns time. Compounds well: the LLM-facing tool
description for `copilot_doctor` becomes a self-help surface for the assistant when delegations
fail.

**Rejected alternatives folded in**: F1.10 `/copilot-doctor`, F1.6 hook awareness, F1.5 secret
risk preflight (rolled in as one diagnostic surface).

## Rejected (with reason)

Each rejection is one-line — preserved for future reconsideration.

| Idea                                                          | Frame | Reason                                                                                                                                |
| ------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Hook-based push to delete `copilot_output`** (F2.1, F2.4)   | F2    | Copilot user-level hooks fire for ALL spawned subprocesses, not just plugin-owned ones — wrong layer for a clean push API. Roll into S7's hook awareness instead. |
| **OTel telemetry zero-instrumentation** (F4.10)               | F4    | Pre-mature for a 0.x plugin with no telemetry users. Comes free if S1's event bus ships; defer the OTel subscriber.                                                |
| **Composable delegation pipelines / DAGs** (F3.3)             | F3    | Speculative; OpenCode itself orchestrates. Premature complexity.                                                                                                  |
| **Bidirectional `--ask_user` relay** (F3.5)                   | F3    | Inverts the unattended-delegation value prop; introduces a deadlock-prone session-injection contract. Defer.                                                      |
| **Plan-mode → OpenCode todos integration** (F3.9)             | F3    | Blurs the OpenCode-orchestrates / Copilot-delegates boundary. Niche.                                                                                              |
| **Hook-driven auto-delegation on session events** (F3.10)     | F3    | Intrusive. Conflicts with explicit-invocation preference.                                                                                                          |
| **Default-deny secrets + risk preflight** (F1.5, F2.9)        | F1/F2 | Documenting `--secret-env-vars` in README and forwarding the flag is enough; UI preflight is niche. Roll into S7.                                                  |
| **Hook-awareness quarantine mode** (F1.6)                     | F1    | Hook-side-effects-on-spawn is a Copilot CLI design, not the plugin's job to "quarantine." Document; don't gate.                                                    |
| **Non-interactive safety profile** (F1.8)                     | F1    | The plugin already passes `--no-ask-user --allow-all-tools`. Just naming the existing default.                                                                     |
| **Auto-inferred `--add-dir` for workspace** (F2.7)            | F2    | Error-prone; sibling repos may pull in unrelated work, security boundary risk. Manual `--add-dir` is fine.                                                         |
| **Agent fs.watch caching** (F2.8)                             | F2    | Per-spawn discovery is fast (one readdir); fs.watch adds cleanup and rename/delete edge cases. Premature.                                                          |
| **Parameterized prompt macros** (F2.10)                       | F2    | OpenCode itself can do template expansion in user-space; not the plugin's role.                                                                                    |
| **Workspace continuity guard for resume** (F1.9)              | F1    | Folded into S2: `CopilotProcess.resume` re-applies the original `--add-dir` set automatically.                                                                     |

## Cross-cutting note

S1 ⇄ S2 ⇄ S5 form a tight bundle: ACP-mode delegations (S2) emit JSONL events through the
event bus (S1), produce structured transitions the watchdog (S5) consumes for stale
detection, and the modal (S1) renders all of it. Brainstorming any one of S1/S2/S5 should
explicitly ask whether a unified design or independent designs better serve v0.2.x scope.

S3 ⇄ S4 form another tight bundle: the agent manifest (S3) is the natural input to per-agent
tool registration (S4). Brainstorm them together.

S6 ⇄ S1 share a renderer; ship S1 first, then S6 trivially.

S7 stands alone — pure quality investment, scoped tightly enough to ship in any v0.2.x
release without coupling to the others.

## Open threads (not survivors, worth a note)

- **Knowledge-compounding loop** (S6 + `ce:compound`): every transcript optionally feeds the
  project's institutional knowledge. Promising but premature; revisit when the
  `docs/solutions/` corpus has 10+ entries and the cost/value of automated capture is
  clearer.
- **Cross-session delegation pool with file-based registry** (CC-1 deepened): once persistence
  ships (S1), the question of "should multiple OpenCode sessions on one machine see the same
  pool?" becomes answerable. Defer the design until we know what S1's persistence layer looks
  like.
- **`copilot_list_agents` tool** (KNOWN_ISSUE): superseded by S4 if per-agent registration
  ships.

## Recommended handoff

Take **S1 (visibility platform)** into `ce:brainstorm` next.

- It's the explicit user focus and the v0.2.x signature feature.
- Its sub-bundle (event bus + persistent registry + slash-modal) is the largest open design
  question — multiple viable shapes, real technical viability question (no OpenCode precedent).
- S2 is the next-largest investment but its design space is more constrained (the strategy
  pattern is well-understood); brainstorm it second.
- S3, S4, S5, S7 are smaller-scope; can be picked up via `ce:work` directly without a separate
  brainstorm step once the foundation is in place.
