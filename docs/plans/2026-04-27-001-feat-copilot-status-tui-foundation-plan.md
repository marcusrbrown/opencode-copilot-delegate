---
title: "feat: /copilot-status TUI foundation (v0.2.0)"
type: feat
status: active
date: 2026-04-27
origin: docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md
target_release: v0.2.0
prerequisite_plan: docs/plans/2026-04-27-002-fix-runtime-hardening-pre-tui-plan.md
---

# feat: /copilot-status TUI foundation (v0.2.0)

## Overview

Lay the v0.2.x visibility-platform foundation by turning `opencode-copilot-delegate` into a two-entrypoint package. The existing server-side plugin keeps its current responsibilities. A new TUI half ships alongside it: an opt-in `@opencode-ai/plugin/tui` that registers a `/copilot-status` command, opens a modal listing running delegations, exposes a cancel keybind, and emits a spawn-toast lifecycle signal. The two halves communicate over an HTTP-over-localhost RPC channel published via a per-session port file with a per-process auth token; the port file lives at `0o600` permissions.

The PID-file orphan reaper that was originally bundled here ships first as a v0.1.1 patch — see `docs/plans/2026-04-27-002-fix-runtime-hardening-pre-tui-plan.md`. v0.2.0 builds on top of that hardening.

v0.2.1 (drilled fullscreen view) and v0.2.2 (recent-history + concurrent navigation) are out of scope and will get their own brainstorms once this lands.

## Problem Frame

`opencode-copilot-delegate` v0.1 makes long-running Copilot delegations possible but inconvenient to monitor — a 5-minute delegation looks identical to a hung subprocess until the completion toast fires. `copilot_output` exists but requires a tool call away from the chat. The brainstorm (`docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md`) commits the plugin to a chat-native visibility surface mirroring OpenCode's native subagent rendering — modal listing in v0.2.0, drilled view + history later.

The architectural commit is one-way: shipping a `tui` entrypoint means users add the plugin to their `tui.jsonc`. Removing it is a breaking change. v0.2.0's job is to ship that commit cleanly so v0.2.1 / v0.2.2 can build on top.

## Requirements Trace

From the origin brainstorm — v0.2.0 functional requirements (R8 moved to the pre-TUI hardening plan):

- **R1** — `/copilot-status` slash command opens the modal at the list view. (origin: `docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md` §"v0.2.0 — functional requirements" → "Slash command". The brainstorm's wording suggests server-side registration; the plan registers from the TUI half because the slash command is meaningless without the TUI to render the dialog — see Key Decisions.)
- **R2** — Modal list view: header shows `<n> running · 0 recent`; rows show status badge / abbreviated task ID / agent / model / elapsed (live) / tool-call count; running-only in v0.2.0. (origin: same → "Modal — list view")
- **R3** — Cancel via `c` keybind on focused row → confirm dialog → existing `copilot_cancel` machinery via authenticated RPC → row transitions to `cancelling` then `cancelled`, then is removed per running-only rule. (origin: same → "Cancel flow" + UX micro-spec)
- **R4** — Spawn lifecycle toast: `client.tui.showToast({ body: { message: 'Copilot delegation cpl_xxxxxxxx started', variant: 'info' } })` from `copilot_delegate` immediately after task creation. Existing completion toast unchanged. (origin: same → "Lifecycle notifications". Note: the existing `notify.ts` API uses a `body:` wrapper around `{ message, variant }`; new spawn-toast helper follows the same shape.)
- **R5** — v0.2.0 keybinds in the list view: `↑`/`k`, `↓`/`j`, `c`, `Esc`. No `Enter` / drill-in / scroll keys (those belong to v0.2.1). The confirm-card dialog adds `←`/`→`/`Enter`/`Space`/`Esc` within its own surface. (origin: same → "Interaction model")
- **R6** — UX micro-specs: focus indicator (inverse video + `●` prefix on running badge), empty state, loading state, RPC error state, cancel-confirm dialog flow, list scroll behavior — including footer hints (`Esc close`) on empty/error states and explicit focus behavior after a cancelled row is removed. (origin: same → "v0.2.0 UX micro-specs")
- **R7** — TUI plugin is opt-in via user's `tui.jsonc`; server-side keeps working without it; `/copilot-status` shows a graceful RPC-error state when the TUI half fails to load or the RPC server is unreachable. (origin: §"Architectural commit" + success criteria)
- **R9** — Pull-from-registry event delivery: server-side exposes a list query method; v0.2.0 only needs the *list* endpoint (plus health and cancel) — per-task event endpoint lands with v0.2.1. (origin: §"Prerequisites for ce:plan" #4)

**R8 is in the pre-TUI hardening plan** (see `prerequisite_plan` frontmatter). v0.2.0 assumes the orphan reaper has already shipped and the runtime parser is guarded; both are independent runtime correctness fixes that don't depend on the TUI architecture.

Performance / compatibility success criteria from the origin doc:
- List populates within one localhost-HTTP round-trip (≤250ms target).
- Cancel kills subprocess within 1 second of confirm.
- Plugin keeps working when TUI half is not installed; graceful RPC-error state when installed-but-unreachable.

## Scope Boundaries

- **No drilled fullscreen view** — that's v0.2.1's brainstorm.
- **No recent-history surface** — that's v0.2.2.
- **No expandable output cards / concurrent ←/→ navigation in the list view** — v0.2.2.
- **No persistent task storage** — in-memory only.
- **No sidebar / always-visible panel** — modal-only across v0.2.x.
- **No new slash commands beyond `/copilot-status`** — cancel is keybind-only.
- **No production code in this PR for resume/connect (S2), watchdog (S5), transcript export (S6), or `copilot_doctor` (S7)** — separate ideation lines.
- **No upstream behavior change to existing `copilot_delegate` / `copilot_output` / `copilot_cancel` tools beyond the additions enumerated in Unit 4.** (Specifically: `copilot_delegate` adds the spawn-toast call; the cancel-helper extraction touches `copilot_cancel`'s callsite to share machinery with the RPC handler. No changes to return shapes or error contracts.)
- **No replacement of the `BUILTIN_AGENTS` constant** — tracked separately.
- **No PID-file orphan reaper or parser cancel-race guard** — both ship in the pre-TUI hardening plan.

### Deferred to Separate Tasks

- **PID-file orphan reaper + parser cancel-race guard** — `docs/plans/2026-04-27-002-fix-runtime-hardening-pre-tui-plan.md`, ships as v0.1.1 before v0.2.0.
- **Upstream lifecycle-hook feature request to `anomalyco/opencode`** — file from the v0.2.0 implementation PR with a code TODO pointing at the issue. Brainstorm open question #2.
- **`bunx opencode-copilot-delegate doctor` setup helper** — defer to v0.3+ once the user-install pattern stabilizes.
- **`@opencode-ai/plugin` peer-dep version verification against the host's bundled SDK** — verify at implementation time; bump may be required to `>= 0.1.99` to match Magic Context's working baseline.

## Context & Research

### Relevant Code and Patterns

**This repo (existing surfaces to integrate with):**
- `src/index.ts` — current plugin entrypoint exporting `CopilotDelegatePlugin`. Add RPC server startup; spawn-toast wiring is in `src/tools/delegate.ts`.
- `src/tools/delegate.ts` — `createDelegateTool`. Add the spawn-toast call here after `createTask` succeeds, before returning `{ task_id }`.
- `src/tools/cancel.ts` — `createCancelTool`. Currently 23 lines, only calls `task.abortController.abort()`. The actual kill chain lives in `subprocess.ts`'s abort listener. Unit 4 extracts the cancel call into a shared helper that both this tool and the RPC server's cancel handler can invoke.
- `src/runtime/task-registry.ts` — `taskRegistry`. List-RPC handler reads from this. `taskRegistry.getAllTasks()` exists; add a `listRunning()` projection that returns the schema-shaped list (no event buffers).
- `src/runtime/notify.ts` — existing `notifyCompletion`, manually-typed `NotifyClient`. The `client.tui.showToast` API takes `{ body: { message, variant } }`; spawn-toast helper follows that shape.
- `src/runtime/subprocess.ts` — current home of the JSONL data handler (an anonymous callback inside `spawnCopilot`, not a named function). v0.2.0 does not modify this file; the cancel-race guard belongs to the pre-TUI hardening plan.
- `src/runtime/envelope.ts` — `tool_calls` array via `summary.tool_calls.length` for the list-view tool-call count column.
- `src/lib/kill-tree.ts` — `killProcessTree`. Used indirectly via the existing abort-listener path; not directly referenced by v0.2.0 code.
- `package.json` — root manifest. New `exports["."]` (preserve current default), `exports["./tui"]`, `oc-plugin` field, opentui + solid-js + zod deps, peer-dep bump to `@opencode-ai/plugin >= 0.1.99`.
- `tsconfig.json` — current `module: NodeNext`, no JSX. Unit 1 adds JSX support; see Key Decisions for the precise config given the `jsx: "preserve"` + `jsxImportSource` interaction.
- `tests/` — bun-test files at top level (`*.test.ts`). New work follows the same shape; TUI-component tests live alongside source under `src/tui/__tests__/`.

**Magic Context precedent (read-only reference, not a dependency):**
- `node_modules/@cortexkit/opencode-magic-context-tui/src/index.tsx` — TUI plugin shell; `api.command.register`, `api.ui.dialog.replace`, `api.ui.toast`, `api.lifecycle.onDispose` patterns; SolidJS render via `<Render onDismiss={...} />`.
- `node_modules/@cortexkit/opencode-magic-context-tui/src/api.ts` — TUI-side HTTP RPC client over `fetch`. (Their notification poller is not needed in v0.2.0.)
- `node_modules/@cortexkit/opencode-magic-context-tui/package.json` — `oc-plugin: ["tui"]`, `exports["./tui"]: ./src/index.tsx`, opentui + solid-js as direct deps, `@opencode-ai/plugin` as peer.
- `node_modules/@cortexkit/opencode-magic-context/src/server.js` — `node:http` server on `127.0.0.1`, port written to `~/.cache/opencode/<scope>/server-port.json`, JSON request/response routing.

### Institutional Learnings

- `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md` — `OPENCODE_CONFIG_DIR` + `OPENCODE_CONFIG_CONTENT` isolation pattern. Relevant if v0.2.0 adds an integration test that drives `opencode run` against the new plugin.
- `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md` — `--print-logs --log-level DEBUG` workflow.

### External References

- OpenCode plugin SDK page describing `tui` exports: https://opencode.ai/docs/sdk/#tui (referenced from earlier session research).
- `@opentui/solid` runtime: SolidJS over the opentui terminal renderer; pragma `/** @jsxImportSource @opentui/solid */` per-file (see Key Decisions for why per-file pragma is needed).
- `@opentui/core` — base widgets, `<text>`, `<box>`, dialog primitives.

## Key Technical Decisions

- **Single package, dual `exports`.** `opencode-copilot-delegate` stays as one npm package. `package.json` adds `oc-plugin: ["server", "tui"]` and three `exports` entries: `["."]` (preserves the existing default `import 'opencode-copilot-delegate'` semantics — points at `dist/index.js`), `["./plugin"]` (alias for the same artifact), and `["./tui"]` (raw source `./src/tui/index.tsx`). Once `exports` is present, Node ESM ignores `"main"`, so `["."]` is required to keep current consumers working.
- **HTTP RPC over localhost via `node:http`.** Magic Context's proven pattern. Server binds to `127.0.0.1` with port `0` (ephemeral); the assigned port is read inside the `'listening'` event callback (not directly after `listen()`, which returns synchronously before binding completes). Port + auth token written to a **per-session port file** (see below).
- **Per-session port file path.** `<XDG_CACHE_HOME or ~/.cache>/opencode/copilot-delegate/<discriminator>/server-port.json`, where `<discriminator>` is a per-process value derived from `OPENCODE_SESSION_ID` (or equivalent OpenCode env var) when available, falling back to `String(process.pid)`. Eliminates the cross-session collision the singleton path would create. The TUI client reads the same env var to locate its own server.
- **Stale port-file cleanup on startup.** Because `process.pid` is the emergency fallback (used when OpenCode does not set a session env var — e.g. during dev iteration outside the TUI host), a plugin restart with a fresh PID would orphan the previous PID-named directory. At server startup, before `listen()`, `fs.rm(<discriminator-dir>, { recursive: true, force: true })` clears any prior contents under the same discriminator path. This is a no-op when `OPENCODE_SESSION_ID` is stable across restarts; only the PID-fallback case needs the cleanup. Document `OPENCODE_SESSION_ID` (or the resolved equivalent) as the expected production discriminator and `process.pid` as a dev-only emergency path.
- **Authentication token in the port file.** Server generates a 32-byte random token at startup (`crypto.randomBytes(32).toString('base64url')`); writes `{ port, pid, token }` to the port file. Every RPC request must carry the token in an `Authorization: Bearer <token>` header. Unauthenticated or wrong-token requests return 401. Closes the local-DoS vector.
- **Constant-time auth comparison with length normalization.** `crypto.timingSafeEqual` throws when the two `Buffer`s have different lengths, so it cannot be invoked directly on the raw header value. Auth middleware: (1) parse the `Authorization` header; if absent OR not `Bearer`-scheme OR token-half is empty, return 401 immediately without any comparison call; (2) Buffer-encode both the presented token and the server-side token; if lengths differ, return 401 immediately (the length check itself is not constant-time, but neither length nor the absence/presence path leaks anything that wasn't already implicit in 401-vs-200); (3) only when lengths match, call `crypto.timingSafeEqual` for the constant-time compare. This avoids the unhandled exception path entirely while still defending the equal-length case against timing attacks.
- **`0o600` permissions on the port file.** Written via `fs.writeFile(path, data, { mode: 0o600 })` and `fs.chmod(path, 0o600)` after atomic rename. Parent directory created with `0o700`. Other users on shared machines cannot read the token.
- **JSON body parsing.** `node:http` does not parse request bodies. The Unit 3 server collects `data`/`end` chunks per request with a **streaming size guard**: each `data` event increments a running byte total; if the total exceeds 64KB, the server immediately responds 413 and aborts the request (`req.destroy()`) without buffering the rest. Only when `end` fires under the cap does the handler `JSON.parse` the joined buffer inside try/catch and validate against the Zod schema. Bad bodies → 400. Streaming the cap (vs checking after collection) prevents holding a 64KB+ buffer for any request that would be rejected anyway.
- **Pull-only RPC for v0.2.0.** Brainstorm prerequisite #4. Server exposes `GET /health`, `POST /tasks/list`, `POST /tasks/cancel`. No notification poller in v0.2.0. Per-task event endpoint + push poller land in v0.2.1.
- **Slash command registered from the TUI half.** Per Magic Context's working code; the brainstorm's note about server-side registration was based on a stale comment. TUI-side registration via `api.command.register` is correct because invoking `/copilot-status` without a TUI to render the dialog is meaningless. **Verify at implementation time** that the actual field name is `trigger` (per Magic Context's TS) vs `value` (per other docs) — the slash-command shape is the one TUI-API detail not directly verifiable from this repo's `node_modules`.
- **Cancel-confirm via `api.ui.dialog.replace(<ConfirmCard />)`.** opentui has no `DialogConfirm` symbol. Implemented as a SolidJS card with two action buttons (`Cancel Task` destructive, `Keep Running` secondary). On `rpc.tasksCancel` failure, the card stays open and replaces its button row with an inline error message + a single `Dismiss` button. **Locked**: no toast fallback, no card-close-then-toast — inline-only.
- **Cancel-helper extraction.** Unit 4 (not Unit 3) creates `src/runtime/cancel-helper.ts` exposing `cancelTaskById(taskId): { cancelled, error? }`. Both `createCancelTool` (existing) and the RPC `/tasks/cancel` handler (new) call into this single helper. The helper invokes `task.abortController.abort()`; the existing abort listener in `subprocess.ts` handles the actual kill via `killProcessTree`.
- **Spawn toast helper.** Unit 4 adds `notifySpawn(client, taskId)` in `src/runtime/notify.ts` parallel to existing `notifyCompletion`, using the same `client.tui.showToast({ body: { message, variant } })` shape. Variant is always `info`. The helper **explicitly guards `client.tui` undefined** before calling `showToast` (the `NotifyClient` type marks `tui` as always-present, but at runtime the server-side plugin can load without a TUI context when the user has not installed the TUI half) and wraps the call in try/catch to swallow any showToast failure. Both guards are explicit — do not rely on the existing `notifyCompletion`'s accidental safety from try/catch alone.
- **TUI half consumes server-side runtime types only via shared module.** New `src/runtime/rpc-contract.ts` exports the Zod schemas / TypeScript types for RPC request/response shapes (including the auth token field). Server validates inbound; TUI validates outbound. Single source of truth.
- **No build artifact for TUI half.** Source `.tsx` is the export; OpenCode's TUI runtime compiles. `tsc --noEmit` covers typecheck. `bun build` is unchanged. **Caveat from review**: `tsc`'s `jsx: "preserve"` + `jsxImportSource` combination is technically inert — `jsxImportSource` only takes effect with `react-jsx`/`react-jsxdev`. Use per-file `/** @jsxImportSource @opentui/solid */` pragmas (Magic Context does the same) and rely on the bundler (OpenCode's TUI runtime) to honor them. If `tsc --noEmit` fails on JSX element type resolution, fall back to `jsx: "react-jsx"` + `jsxImportSource` in tsconfig and verify the runtime still loads. Documented as an implementation-time gate.
- **Plugin cleanup is best-effort.** Server-side `Hooks` does not expose a dispose hook. RPC server `close()` wires to `process.on('beforeExit', ...)` and `process.on('SIGTERM', ...)`. The pre-TUI hardening plan's orphan reaper covers cases where this fallback misses (subprocesses still running after the cleanup signals).
- **Async plugin factory and tool-call ordering.** `@opencode-ai/plugin`'s `Plugin` type is `(input: PluginInput) => MaybePromise<Hooks>`, so the host awaits the factory before consulting the returned `Hooks` for tool registration. The Unit 4 wiring (`await startRpcServer(...)` inside `src/index.ts` before the factory returns) is therefore safe: the RPC server is bound and the port file is written before any tool can be invoked, so authenticated `/tasks/*` requests cannot race with init. Document this assumption inline in `src/index.ts` next to the `await` so it is visible if the SDK contract ever changes.

## Open Questions

### Resolved During Planning

- **Single package vs split** — single, see Key Decisions.
- **`@opentui/*` dep posture** — direct deps (Magic Context precedent).
- **Slash command registration side** — TUI-side, see Key Decisions.
- **`DialogConfirm` symbol** — doesn't exist; use `dialog.replace(<ConfirmCard />)`.
- **RPC routes for v0.2.0** — `GET /health`, `POST /tasks/list`, `POST /tasks/cancel`. No event endpoint until v0.2.1.
- **PID-file lock strategy** — moot for v0.2.0 (PID file lives in the pre-TUI hardening plan).
- **Server-side `Hooks` dispose presence** — confirmed absent in the installed SDK; cleanup wires to process exit signals.
- **Confirm-card error UX branch** — locked to inline-error; see Key Decisions.
- **Port file path discrimination** — per-session, see Key Decisions.
- **RPC authentication** — bearer token, see Key Decisions.
- **`exports["."]` for backward compatibility** — added; see Key Decisions.

### Deferred to Implementation

- **Live elapsed-time refresh cadence in the modal.** SolidJS reactivity allows 1Hz updates cheaply. Verify in Unit 6 that the render budget at 10 concurrent rows is acceptable; lower cadence if needed.
- **`@opencode-ai/plugin` peer version bump.** Verify the actual minimum at implementation time; brainstorm cites `>= 0.1.99` from Magic Context's manifest.
- **`api.command.register` field name (`trigger` vs `value`).** Verify at implementation against the installed `@opencode-ai/plugin/tui` types.
- **`tsc --noEmit` behavior with `jsx: "preserve"` + per-file pragma.** Verify in Unit 1; fall back to `jsx: "react-jsx"` if it fails.
- **Whether to file the upstream lifecycle-hook issue inside the implementation PR or as a follow-up.** Author's preference at PR time.

## Output Structure

```
src/
├── tui/
│   ├── index.tsx                  # TUI plugin entrypoint (SolidJS + opentui)
│   ├── rpc-client.ts              # HTTP RPC client (reads per-session port file + auth token)
│   ├── components/
│   │   ├── modal-list.tsx
│   │   ├── row.tsx
│   │   ├── empty-state.tsx
│   │   ├── loading-state.tsx
│   │   ├── error-state.tsx
│   │   └── confirm-card.tsx
│   └── __tests__/
│       ├── rpc-client.test.ts
│       ├── modal-list.test.tsx
│       └── confirm-card.test.tsx
├── runtime/
│   ├── rpc-contract.ts            # Shared RPC request/response Zod schemas + types (incl. auth)
│   ├── rpc-server.ts              # node:http server, per-session port file, auth, JSON parsing, route handlers
│   ├── cancel-helper.ts           # Shared cancel helper used by tool + RPC handler
│   └── notify.ts                  # (existing) + new notifySpawn
├── tools/
│   ├── delegate.ts                # (existing) + spawn-toast call
│   └── cancel.ts                  # (existing) refactored to call cancel-helper
└── index.ts                       # (existing) + RPC server startup + best-effort cleanup wiring

tests/
├── rpc-contract.test.ts           # Schema round-trip + edge cases (incl. auth token field)
├── rpc-server.test.ts             # HTTP routing, port-file write, auth check, perms, lifecycle, cancel forwarding
├── cancel-helper.test.ts          # Shared helper behavior, used by tool + RPC paths
├── notify.test.ts                 # (existing) + notifySpawn coverage
└── tools.test.ts                  # (existing) + verify spawn-toast fired
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                 ┌─────────────────────────────────────────────────┐
                 │   OpenCode session (server side)                │
                 │                                                 │
                 │   ┌───────────────┐  spawn  ┌─────┐             │
   user calls    │   │ copilot_      │────────▶│Task │             │      ┌──────────────────────────────────────┐
   from chat     │──▶│ delegate tool │         │Reg  │             │      │ ~/.cache/opencode/copilot-delegate/  │
                 │   │  (+ spawn     │         │istry│             │      │   <session-id-or-pid>/               │
                 │   │   toast)      │         └──┬──┘             │      │   server-port.json                   │
                 │   └───────┬───────┘            │                │      │   { port, pid, token }   (mode 0600) │
                 │           │                    ▼                │      └──────────▲───────────────────────────┘
                 │           ▼              ┌──────────┐           │                 │
                 │   ┌───────────────────┐  │ cancel-  │           │                 │
                 │   │ rpc-server.ts     │  │ helper.ts│           │                 │
                 │   │ (node:http,       │  │ (shared) │           │                 │
                 │   │  bearer auth,     │  │          │           │                 │
                 │   │  JSON body parse) │◀─┤  used by │           │                 │
                 │   │  GET  /health     │  │  tool    │           │                 │
                 │   │  POST /tasks/list │  │  + RPC   │           │                 │
                 │   │  POST /tasks/    ─┼──┘          │           │                 │
                 │   │       cancel      │             │           │                 │
                 │   └─────────┬─────────┘             │           │                 │
                 │             │                       │           │                 │
                 │             └─── writes ────────────────────────┼─────────────────┘
                 └─────────────────────────────────────────────────┘
                                                                                     ▲
                                                                                     │ HTTP fetch
                                                                                     │ Authorization: Bearer <token>
                                                                                     │
                 ┌───────────────────────────────────────────────┐
                 │   OpenCode TUI (TUI plugin)                   │
                 │                                               │
                 │   /copilot-status command                     │
                 │     ↓ (api.command.register)                  │
                 │   Modal list view                             │
                 │     - reads port file via session discriminator│
                 │     - rows: status, taskId, agent, model,     │
                 │       elapsed, tool count                     │
                 │     - keybinds: ↑↓kj c Esc                    │
                 │     ↓ press 'c'                               │
                 │   ConfirmCard (dialog.replace)                │
                 │     - "Cancel Task" / "Keep Running"          │
                 │     - on RPC error: inline error + Dismiss    │
                 │     ↓ confirm                                 │
                 │   POST /tasks/cancel { taskId }               │
                 │     ↓ row → 'cancelling' → 'cancelled' →      │
                 │           removed                              │
                 └───────────────────────────────────────────────┘
```

## Implementation Units

- [ ] **Unit 1: Build prerequisites + package.json + tsconfig**

**Goal:** Land the build-pipeline changes that unblock all downstream TUI work.

**Requirements:** R7 (TUI half opt-in via `tui.jsonc` requires the package to expose a `./tui` export); brainstorm prerequisites #1, #2.

**Dependencies:** None.

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `.changeset/<random>.md` (minor bump per `0.x` policy)
- Create: `src/tui/.gitkeep` (placeholder until Unit 5 lands the source)

**Approach:**
- Add `oc-plugin: ["server", "tui"]` to `package.json`.
- Add `exports["."]: { types: "./dist/index.d.ts", import: "./dist/index.js" }` (preserve current default-import semantics — required because once `exports` is present, Node ESM ignores `"main"`).
- Add `exports["./plugin"]: { types: "./dist/index.d.ts", import: "./dist/index.js" }` (explicit alias for callers that want it).
- Add `exports["./tui"]: { types: "./src/tui/index.tsx", import: "./src/tui/index.tsx" }`.
- Add direct deps: `@opentui/core`, `@opentui/solid`, `solid-js`, `zod` (Zod is currently only a transitive dep via `@opencode-ai/plugin`; v0.2.0 uses it directly in `rpc-contract.ts` and must declare it).
- Pin to versions matching Magic Context's working baseline (`^0.1.40` for opentui, `^1.9.9` for solid-js); resolve actual versions at install time via `bun add`.
- Bump `@opencode-ai/plugin` peer dep to match the host's bundled version.
- Add per-file pragma support to `tsconfig.json` (`jsx: "preserve"` + `jsxImportSource: "@opentui/solid"`). **Implementation gate**: run `bun run typecheck` after Unit 5 adds the first `.tsx` file. If `tsc` fails to resolve JSX element types under `jsx: "preserve"` + per-file pragma, fall back to `jsx: "react-jsx"` and verify the runtime still loads. Document the chosen mode in `AGENTS.md`.
- Single minor changeset for the whole v0.2.0 PR ("v0.2.0 foundation: TUI plugin half + RPC + spawn toast"), not per-unit.

**Patterns to follow:**
- Magic Context's TUI package.json `oc-plugin` + `exports` shape.
- Existing `package.json`'s ordering and quote style (Biome normalizes).

**Test scenarios:**
- *Test expectation: none — pure config + dep changes; downstream units validate via typecheck/build/lint.*

**Verification:**
- `bun install` succeeds; `bun run typecheck` passes (will be re-verified after Unit 5); `bun run build` produces unchanged `dist/index.js`; `bun run lint` clean.
- `import 'opencode-copilot-delegate'` still resolves to `dist/index.js` (verify in a small node `--input-type=module` shell after `bun run build`).
- `node -e "console.log(require('./package.json').exports)"` prints `["."]`, `["./plugin"]`, and `["./tui"]` entries.

---

- [ ] **Unit 2: RPC contract module (Zod schemas + types)**

**Goal:** Single source of truth for HTTP-RPC request/response shapes consumed by both halves, including the auth-token contract.

**Requirements:** R3 (cancel forwarding), R7 (typed error states), R9 (list endpoint).

**Dependencies:** Unit 1.

**Files:**
- Create: `src/runtime/rpc-contract.ts`
- Create: `tests/rpc-contract.test.ts`

**Approach:**
- Export Zod schemas: `HealthResponseSchema`, `TasksListResponseSchema`, `TasksCancelRequestSchema`, `TasksCancelResponseSchema`, plus a `PortFileSchema` describing the on-disk shape (`{ port, pid, token }`).
- `TasksListResponseSchema` carries: `{ tasks: Array<{ taskId, status, agent, model, elapsedMs, toolCallCount, startedAt }> }`. Status enum is `"running"` only in v0.2.0 (the running-only rule); add other variants now to make v0.2.1 a no-schema-change addition.
- `TasksCancelRequestSchema`: `{ taskId: string }` with `cpl_*` prefix regex.
- `TasksCancelResponseSchema`: `{ cancelled: boolean, error?: string }`.
- Export inferred TS types via `z.infer`.
- Use `.strict()` on objects to reject extra fields.

**Execution note:** Test-first per AGENTS.md mandate.

**Patterns to follow:**
- Existing tool-input schemas in `src/tools/*.ts` use the same Zod-then-infer pattern.

**Test scenarios:**
- *Happy path:* `TasksListResponseSchema.parse({ tasks: [] })` succeeds.
- *Happy path:* Round-trip a fully-populated row through `JSON.parse(JSON.stringify(parsed))` and re-validate.
- *Edge case:* `taskId` must match `cpl_*` prefix; missing prefix fails.
- *Edge case:* `elapsedMs` non-negative integer; negative or float fails.
- *Edge case:* `PortFileSchema` requires `token` to be non-empty; missing token fails (rejects servers from older versions that lacked auth).
- *Error path:* Empty `TasksCancelRequestSchema` body fails with required-field error.
- *Error path:* Strict-mode rejection of unknown extra fields on every schema.

**Verification:**
- All scenarios pass via `bun test tests/rpc-contract.test.ts`.

---

- [ ] **Unit 3: HTTP-RPC server (server-side)**

**Goal:** node:http server bound to localhost on ephemeral port, per-session port file with bearer-token auth at `0o600`, three routes wired to the existing task registry.

**Requirements:** R7 (server-side keeps working without TUI), R3 (cancel forwarding via authenticated route), R9 (list endpoint).

**Dependencies:** Unit 2. Unit 4 (cancel-helper) lands alongside; the server takes `cancelTaskById` as an injected dependency so unit-test isolation is clean.

**Files:**
- Create: `src/runtime/rpc-server.ts`
- Create: `tests/rpc-server.test.ts`

**Approach:**
- Export `startRpcServer({ taskRegistry, cancelTaskById, portFileBaseDir, sessionDiscriminator }) → Promise<{ port, token, close() }>`.
- Resolve port-file path: `<portFileBaseDir>/<sessionDiscriminator>/server-port.json`. Default `portFileBaseDir` = `<XDG_CACHE_HOME or ~/.cache>/opencode/copilot-delegate`. Default `sessionDiscriminator` = `process.env.OPENCODE_SESSION_ID ?? String(process.pid)`.
- Generate auth token at startup: `crypto.randomBytes(32).toString('base64url')`.
- Use `node:http` `createServer`; bind to `127.0.0.1` with port `0`. **Read assigned port inside the `'listening'` event callback**, not directly after `listen()` returns (which is synchronous).
- Write `{ port, pid, token }` to port file: ensure parent dir exists with `mkdir({ recursive: true, mode: 0o700 })`; write to `<path>.tmp.<random>` with `{ mode: 0o600 }`; `fs.rename` to final path; `fs.chmod(path, 0o600)` after rename for belt-and-braces.
- Auth middleware: every route except `GET /health` requires `Authorization: Bearer <token>` header matching the generated token. Constant-time comparison via `crypto.timingSafeEqual`. Missing or wrong token → 401 with `{ error: "unauthorized" }`. (Keeping `/health` open lets the TUI client do an initial reachability check before the token-loading step.)
- JSON body parsing helper: collect `request` `data`/`end` chunks into a string (cap at 64KB to defend against memory exhaustion), `JSON.parse` inside try/catch, then validate against the Zod schema. Bad JSON or schema failure → 400 with `{ error: <issue summary> }`.
- Routes:
  - `GET /health` → 200 `{ ok: true, version: <package.json version> }`. No auth.
  - `POST /tasks/list` → 200 `{ tasks: <taskRegistry.listRunning() projection> }`. Auth required.
  - `POST /tasks/cancel` `{ taskId }` → invokes `cancelTaskById(taskId)`; returns 200 `{ cancelled: true }` on success, 404 `{ error: "no such task" }` for unknown ID. Auth required.
- Catch-all → 404.
- `close()` returns a Promise wrapping `server.close(callback)`; after close, unlink the port file (best-effort, non-fatal).
- Logging: minimal; route through whatever logging the existing server-side plugin uses (`console.error` in tests is fine).

**Execution note:** Test-first per AGENTS.md mandate.

**Patterns to follow:**
- Magic Context's `node_modules/@cortexkit/opencode-magic-context/src/server.js` for server lifecycle + port-file pattern. Adapt to TS + auth + per-session path.

**Test scenarios:**
- *Happy path:* `startRpcServer` returns a port > 0 and a non-empty token; port file exists at `<dir>/<discriminator>/server-port.json` with `mode === 0o600` (verify via `fs.stat`).
- *Happy path:* `GET /health` returns 200 with `{ ok: true, version }` and does NOT require auth.
- *Happy path:* `POST /tasks/list` with correct `Authorization: Bearer <token>` returns the running tasks; completed/failed tasks are filtered out (server uses `listRunning()` projection).
- *Happy path:* `POST /tasks/cancel { taskId }` with auth invokes the injected `cancelTaskById` and returns `{ cancelled: true }`. Idempotent: second call returns the same.
- *Edge case:* `POST /tasks/cancel { taskId: "cpl_unknown" }` returns 404.
- *Edge case:* Two `startRpcServer` calls with different discriminators succeed concurrently; each writes to its own port file; tokens differ; cross-token requests fail with 401.
- *Error path:* `POST /tasks/cancel` without `Authorization` header returns 401 (no `timingSafeEqual` invocation — verify auth middleware short-circuits before the compare call).
- *Error path:* `POST /tasks/cancel` with `Authorization: Basic abc` (wrong scheme) returns 401.
- *Error path:* `POST /tasks/cancel` with `Authorization: Bearer` (no token value) returns 401.
- *Error path:* `POST /tasks/cancel` with `Authorization: Bearer short` (token shorter than server's) returns 401 without throwing (length-mismatch path).
- *Error path:* `POST /tasks/cancel` with `Authorization: Bearer <43-char-but-wrong-token>` returns 401 (verify `timingSafeEqual` is reached and returns false; same response time as a correctly-formed-wrong-value).
- *Error path:* `POST /tasks/cancel` with malformed JSON body returns 400.
- *Error path:* `POST /tasks/cancel` with `{ taskId: 123 }` returns 400 with Zod validation message.
- *Error path:* Request body that streams past 64KB returns 413 mid-stream (verify the server destroys the request before the full body arrives — send a body slowly, observe the response fires before the final chunk).
- *Lifecycle:* `close()` stops the server, unlinks the port file; subsequent `fetch` to the old port fails with `ECONNREFUSED`.
- *Integration:* Spawn an actual `copilot` subprocess via `taskRegistry`, list it via `/tasks/list`, cancel it via `/tasks/cancel`, observe the abort-listener triggers `killProcessTree`.

**Verification:**
- All scenarios pass; no port leaks between tests (each test uses a fresh temp dir for port file); zero zombie processes after the integration scenario.

---

- [ ] **Unit 4: Cancel-helper extraction + spawn toast + plugin init wiring**

**Goal:** Extract the shared cancel call into `src/runtime/cancel-helper.ts`. Add the spawn-toast helper. Wire the RPC server into plugin init.

**Requirements:** R3 (cancel-from-RPC uses same machinery as `copilot_cancel`), R4 (spawn toast), R7 (RPC server starts when plugin loads).

**Dependencies:** Units 1, 2, 3.

**Files:**
- Create: `src/runtime/cancel-helper.ts`
- Create: `tests/cancel-helper.test.ts`
- Modify: `src/tools/cancel.ts` (refactor to call the helper)
- Modify: `src/tools/delegate.ts` (call notifySpawn after createTask)
- Modify: `src/runtime/notify.ts` (add notifySpawn)
- Modify: `tests/notify.test.ts`
- Modify: `tests/tools.test.ts`
- Modify: `src/index.ts` (start RPC server + best-effort cleanup wiring)

**Approach:**
- `src/runtime/cancel-helper.ts`: export `cancelTaskById(taskRegistry, taskId): { cancelled: boolean, error?: string }`. Implementation: look up task; if missing, return `{ cancelled: false, error: "no such task" }`; if found, call `task.abortController.abort()` and return `{ cancelled: true }`. The existing abort listener in `subprocess.ts` already handles the kill — no changes there.
- Refactor `src/tools/cancel.ts` `createCancelTool` to delegate to `cancelHelper.cancelTaskById`. Behavior and return shape unchanged from the tool's perspective.
- `src/runtime/notify.ts`: add `notifySpawn(client, taskId)` next to `notifyCompletion`. Body: `await client.tui.showToast({ body: { message: \`Copilot delegation ${taskId} started\`, variant: 'info' } })`. **Important: use the `body:` wrapper** — the existing `NotifyClient` API requires it. Same try/catch swallow on failure.
- `src/tools/delegate.ts`: after `createTask` returns, before returning `{ task_id }`, call `notifySpawn(client, taskState.taskId).catch(() => {})`. Fire-and-forget.
- `src/index.ts`: at plugin init, `await startRpcServer({ taskRegistry, cancelTaskById, ... })`. Store the close handle. Wire `process.on('beforeExit', () => server.close())` and `process.on('SIGTERM', () => server.close())`. Document this as a best-effort fallback; the pre-TUI hardening plan's orphan reaper covers the gap.

**Execution note:** Test-first per AGENTS.md mandate.

**Patterns to follow:**
- Existing `notifyCompletion` shape in `src/runtime/notify.ts` (preserves the `body:` wrapper).
- Existing `createDelegateTool` post-spawn flow in `src/tools/delegate.ts`.

**Test scenarios:**
- *Happy path (cancel-helper):* Known running task → `task.abortController.abort()` invoked; returns `{ cancelled: true }`.
- *Edge case (cancel-helper):* Unknown task ID → returns `{ cancelled: false, error: "no such task" }` without throwing.
- *Happy path (notifySpawn):* Stub client's `tui.showToast` called once with `{ body: { message: 'Copilot delegation cpl_abc started', variant: 'info' } }`.
- *Error path (notifySpawn):* `client.tui.showToast` throws → `notifySpawn` swallows; does not propagate.
- *Integration (delegate):* `createDelegateTool` execute, on success, fires the spawn toast (verify via stub client recording the call) AND returns `{ task_id }` — toast failure does not block the return.
- *Integration (cancel parity):* `createCancelTool` and the RPC handler both invoke `cancelTaskById` for the same `taskId`; observable behavior (status transition, killProcessTree call) is identical.
- *Lifecycle:* Plugin init starts the RPC server; `process.on('beforeExit', ...)` calls `server.close()` (verify via spy).

**Verification:**
- All scenarios pass; existing 90+ unit tests still pass; `bun run typecheck` + `bun run lint` + `bun run build` clean.

---

- [ ] **Unit 5: TUI plugin entrypoint + RPC client**

**Goal:** New `src/tui/index.tsx` registers `/copilot-status` command and instantiates the modal-list component. RPC client reads the per-session port file + auth token.

**Requirements:** R1 (slash command), R7 (graceful when RPC unreachable).

**Dependencies:** Units 1, 2, 3 (RPC server must exist for the client to call). Independent of Unit 4 in code (can be developed against a stub server).

**Files:**
- Create: `src/tui/index.tsx`
- Create: `src/tui/rpc-client.ts`
- Create: `src/tui/__tests__/rpc-client.test.ts`

**Approach:**
- `src/tui/index.tsx`: default-export the TUI plugin factory. File-pragma `/** @jsxImportSource @opentui/solid */` at the top. Register one command via `api.command.register`. **Field-name verification**: Magic Context's source uses `trigger`; if the installed `@opencode-ai/plugin/tui` types disagree, switch to `value`. Document the chosen field in `AGENTS.md`. On invoke, mount `<ModalList api={api} rpc={rpcClient} />` via `api.ui.dialog.replace`.
- `src/tui/rpc-client.ts`: locate the per-session port file using the same discriminator logic as the server (`process.env.OPENCODE_SESSION_ID ?? String(process.pid)`); read and validate against `PortFileSchema`. Expose `health()`, `tasksList()`, `tasksCancel(taskId)`. Each is a `fetch` carrying `Authorization: Bearer <token>` and returning the parsed Zod-validated response.
- Typed errors: `RpcUnreachableError` (port file missing, fetch failure), `RpcServerError` (non-2xx with status), `RpcAuthError` (401), `RpcValidationError` (schema mismatch).
- `api.lifecycle.onDispose(() => { abortController.abort(); /* clear timers */ })`.

**Execution note:** Test-first per AGENTS.md mandate.

**Patterns to follow:**
- `node_modules/@cortexkit/opencode-magic-context-tui/src/index.tsx` for the plugin factory shape.
- `node_modules/@cortexkit/opencode-magic-context-tui/src/api.ts` for the RPC-client shape (without the notification poller).

**Test scenarios:**
- *Happy path:* `tasksList()` against a stub HTTP server returns parsed `{ tasks: [...] }`; the request includes `Authorization: Bearer <token>`.
- *Happy path:* `tasksCancel('cpl_x')` against a stub returning `{ cancelled: true }` resolves with `cancelled === true`.
- *Edge case:* Per-session port file does not exist → `health()` rejects with `RpcUnreachableError`.
- *Edge case:* Port file present but lacks `token` field → `RpcValidationError` (rejects servers from older versions).
- *Edge case:* Server returns 401 → `RpcAuthError` (typed distinctly from generic 5xx).
- *Edge case:* Server returns 500 → `RpcServerError` with status code.
- *Edge case:* Server returns body that fails Zod validation → `RpcValidationError` with the issues attached.
- *Lifecycle:* `dispose` aborts an in-flight `fetch`.
- *Integration:* Slash command registers with the verified field name (`trigger` or `value`). Stub the API and assert exactly one registration call.

**Verification:**
- All scenarios pass; `bun run typecheck` clean (verifies tsconfig JSX setup works); the TUI plugin loads without crashing when imported from a Node REPL via the source file.

---

- [ ] **Unit 6: Modal list view component + keybinds + UX micro-specs**

**Goal:** SolidJS component rendering R2 (list rows) + R5 (keybinds) + R6 (focus indicator, empty/loading/error states with full UX micro-spec compliance).

**Requirements:** R2, R5, R6.

**Dependencies:** Units 2, 5.

**Files:**
- Create: `src/tui/components/modal-list.tsx`
- Create: `src/tui/components/row.tsx`
- Create: `src/tui/components/empty-state.tsx`
- Create: `src/tui/components/loading-state.tsx`
- Create: `src/tui/components/error-state.tsx`
- Create: `src/tui/__tests__/modal-list.test.tsx`

**Approach:**
- Stateful SolidJS component. On mount, calls `rpc.tasksList()` (Unit 5). State machine: `loading` → (`populated` | `empty` | `error`).
- **Header**: `<n> running · 0 recent` (recent count is always 0 in v0.2.0; field reserved for v0.2.2). During loading, header reads `Loading delegations…` instead. During error, header reads `Status unavailable.`. The header component is owned by the modal-list root, not by the per-state child components — this keeps header behavior consistent across states.
- Row: 6 columns from the brainstorm spec; status badge `●` prefix when `running`; focused row uses inverse video.
- **Footer**: persistent across all states. Empty/error states show `Esc close`. Populated state shows `↑↓ navigate · c cancel · Esc close`. (Brainstorm specifies `Esc close` for empty/error; populated state's footer is a small affordance addition.)
- Keybind handler via opentui's input subscription:
  - `↑` / `k`: decrement focus index, wrap.
  - `↓` / `j`: increment focus index, wrap.
  - `c`: open `<ConfirmCard taskId={focused.taskId} ... />` via `api.ui.dialog.replace` (Unit 7).
  - `Esc`: dismiss the modal.
- Live elapsed: SolidJS signal updated at 1Hz via `setInterval`; cleared on unmount.
- **Empty state**: vertically-centered body `No Copilot delegations are running.` + `Start one with the copilot_delegate tool, then reopen /copilot-status.`. Header `0 running · 0 recent`. Footer `Esc close`.
- **Loading state**: header `Loading delegations…`. Body empty. Footer `Esc close`. Auto-resolves on first RPC response.
- **Error state**: header `Status unavailable.`. Body `The Copilot delegate TUI plugin is not responding.` + `Try reloading the plugin (or run /copilot-status again).`. Footer `Esc close`.
- Scroll behavior: list region fills available terminal height minus header (1) + footer (1) = 2 reserved lines; rows scroll with focus-wrap at top/bottom.
- **State transitions during cancel** (interfaces with Unit 7):
  - On `c` keypress, focused row's status badge stays `running` while the confirm dialog is open.
  - On `Cancel Task` confirm, the list refetches via `rpc.tasksList()`. The next render shows the row with `cancelling` (server-side has flipped status). On the subsequent refetch (manually triggered after a short delay, or on the next `c`-driven refetch), the row reaches `cancelled` and is filtered out by the running-only rule.
  - Focus after row removal: focus index is clamped to `Math.min(prevIndex, newRowCount - 1)`. If the list is now empty, transition to empty-state.

**Execution note:** Test-first per AGENTS.md mandate (component tests use opentui's testing utilities).

**Patterns to follow:**
- Magic Context's TUI components for SolidJS-on-opentui idioms.

**Test scenarios:**
- *Happy path:* Mount with 3 running tasks → 3 rows render; first row is focused (inverse video applied); header reads `3 running · 0 recent`; footer reads `↑↓ navigate · c cancel · Esc close`.
- *Happy path:* `↓` keypress moves focus to row 2.
- *Happy path:* `↑` from row 0 wraps to last row.
- *Happy path:* `Esc` invokes the dismiss callback.
- *Edge case:* Mount with empty registry → empty-state body rendered; header shows `0 running · 0 recent`; footer shows `Esc close`.
- *Edge case:* Mount + RPC resolves slowly → loading-state header `Loading delegations…` visible during the gap; transitions to populated/empty when it resolves.
- *Error path:* RPC throws `RpcUnreachableError` → error-state header `Status unavailable.`; spec'd two-line body; footer `Esc close`.
- *Error path:* RPC throws `RpcAuthError` → error-state renders (treated as unreachable from the user's perspective).
- *Integration:* `c` keypress with focused running task triggers `dialog.replace` with the confirm card containing the focused row's `taskId`.
- *Integration:* After `Cancel Task` confirms via the card, the modal-list refetches; row appears with `cancelling` status; on the next refetch the row is removed and focus index is clamped.
- *Integration:* Live elapsed updates: at t=0 row reads `0s`, after a 1.1s tick reads `1s` (use fake timers).
- *Edge case:* 10 concurrent tasks (`MAX_CONCURRENT` cap) → all 10 rows render; arrow keys cycle through all 10 with wrap.
- *Edge case (last-row cancel → empty):* List has exactly 1 running task. Cancel via `c` → confirm → row reaches `cancelled` and is removed by the running-only filter → list transitions to the empty-state component (header `0 running · 0 recent`, empty-state body, footer `Esc close`). Verify focus index does not crash on the empty list.

**Verification:**
- All scenarios pass; component `tsc --noEmit` clean; visual smoke (manual at implementation time) shows the modal opens via `/copilot-status` against a session with running delegations.

---

- [ ] **Unit 7: Cancel-confirm dialog + cancel forwarding**

**Goal:** ConfirmCard component + RPC cancel wiring; closes the loop on R3 with the locked inline-error UX branch.

**Requirements:** R3, R6 (cancel-confirm dialog shape).

**Dependencies:** Units 5, 6.

**Files:**
- Create: `src/tui/components/confirm-card.tsx`
- Create: `src/tui/__tests__/confirm-card.test.tsx`
- Modify: `src/tui/components/modal-list.tsx` (wire `c` keybind to render the card; on confirm, call `rpc.tasksCancel`; on cancel/dismiss, return to list with focus retained)

**Approach:**
- `<ConfirmCard taskId message buttons onConfirm onCancel onDismissAfterError />`. Two button widgets in the normal state; transitions to a single `Dismiss` button after an RPC error.
- Header: `Cancel Copilot delegation cpl_xxxxxxxx?` (full task ID, not abbreviated).
- Buttons (normal state): `Cancel Task` (destructive, default focus), `Keep Running` (secondary).
- Keybinds (normal state): `Enter` / `Space` activates focused button; `←` / `→` swap focus between buttons; `Esc` is treated as `Keep Running`.
- On `Cancel Task` confirm: invoke `rpc.tasksCancel(taskId)`; on success, fire `onConfirm`. The modal-list (Unit 6) handles the refetch and row state transition.
- On `Keep Running` (or `Esc`): fire `onCancel`; modal-list returns with focus on the previously-focused row.
- **Inline error branch (locked)**: on `rpc.tasksCancel` failure (`RpcUnreachableError` / `RpcServerError` / `RpcAuthError`), the card stays open. The button row is replaced with a one-line error message (`Cancel failed: <reason>`) and a single `Dismiss` button (focused by default). `Enter` / `Space` / `Esc` all activate `Dismiss`. On dismiss, fire `onDismissAfterError`; modal-list returns to normal list view with focus on the previously-focused row.
- Background dim of the underlying modal is opentui's standard dialog-overlay behavior.
- In-flight guard: while the `rpc.tasksCancel` call is pending, ignore further `Enter` / `Space` / button activations to prevent double-cancels.

**Execution note:** Test-first per AGENTS.md mandate.

**Patterns to follow:**
- Magic Context's two-button dialog patterns where applicable; otherwise base on opentui's `<dialog>` examples.

**Test scenarios:**
- *Happy path:* Mount with `taskId='cpl_abc'` → header reads `Cancel Copilot delegation cpl_abc?`; default focus on `Cancel Task`.
- *Happy path:* `Enter` on `Cancel Task` invokes `rpc.tasksCancel('cpl_abc')` and fires `onConfirm`.
- *Happy path:* `→` then `Enter` fires `onCancel` (focus moved to `Keep Running`).
- *Happy path:* `Esc` fires `onCancel` regardless of current focus.
- *Edge case (in-flight guard):* User presses `Enter` rapidly twice → `rpc.tasksCancel` invoked exactly once.
- *Error path (inline error):* `rpc.tasksCancel` throws `RpcUnreachableError` → card transitions to error state: button row replaced with error message + single `Dismiss` button; `Enter` activates `Dismiss`; `onDismissAfterError` fires.
- *Error path (inline error):* Same flow for `RpcServerError` and `RpcAuthError`.
- *Integration:* From modal-list, `c` keypress on focused row mounts the card; `Enter` confirms; `onConfirm` triggers the modal-list refetch.

**Verification:**
- All scenarios pass; manual smoke at implementation time: in a real session with a running delegation, `/copilot-status` → `c` on the row → `Enter` → row transitions to `cancelling` then disappears; `copilot_output cpl_xxx` confirms `cancelled` status from the server side.

---

## Definition of Done (PR housekeeping; not a planning unit)

These updates ride with the v0.2.0 implementation PR but are not numbered units (per scope-guardian's recommendation that pure docs not be elevated to planning-unit status):

- **README.md**: under Known Limitations, add the v0.2.0 entries for the architectural commit (TUI half opt-in via `tui.jsonc`, RPC server posture). Note the upstream-issue link for the dispose-hook workaround once filed.
- **README.md**: new section "Optional: install the TUI half" with one-paragraph instructions for adding `opencode-copilot-delegate` to the user's `tui.jsonc`.
- **AGENTS.md**: extend the architecture tree to include `src/tui/`, `src/runtime/rpc-server.ts`, `src/runtime/cancel-helper.ts`. Add a one-paragraph "Two-entrypoint architecture" subsection explaining the server/TUI split.
- **AGENTS.md**: document the resolved `tsconfig.json` JSX mode (`jsx: "preserve"` + per-file pragma if it works, else `jsx: "react-jsx"`) and the resolved `api.command.register` field (`trigger` vs `value`).

## System-Wide Impact

- **Interaction graph:** `copilot_delegate` tool now triggers a TUI toast in addition to the existing in-flight machinery. RPC server is a new long-lived listener inside the plugin's lifecycle. The TUI plugin half registers a slash command that is invisible to non-TUI consumers. `copilot_cancel` tool and the RPC `/tasks/cancel` route share the same cancel-helper.
- **Error propagation:** RPC errors are typed (`RpcUnreachableError`, `RpcServerError`, `RpcAuthError`, `RpcValidationError`) and surfaced as the modal's error state or the confirm-card's inline-error branch.
- **State lifecycle risks:** Per-session port file is the new shared state. Per-session path eliminates the cross-session collision class. Cleanup runs best-effort on `beforeExit`/`SIGTERM`; the pre-TUI hardening plan's reaper covers misses.
- **API surface parity:** No change to existing tools' return shapes or error contracts. `copilot_delegate` adds one fire-and-forget toast call. `copilot_cancel` is functionally unchanged but factored through `cancel-helper` so the RPC handler can share the path.
- **Integration coverage:** Unit 3's "Integration" scenario exercises the cross-layer flow `RPC → cancel-helper → abortController → killProcessTree`. Unit 4's "Integration (cancel parity)" verifies tool and RPC paths produce identical observable behavior. End-to-end TUI testing (modal → keybind → RPC → kill) requires a running OpenCode TUI runtime; manual verification at implementation time, no automated end-to-end test in v0.2.0.
- **Unchanged invariants:** `task-registry.ts`'s `MAX_CONCURRENT` cap, the `cpl_` task ID prefix, the `notifyCompletion` shape, the `client.session.prompt({ noReply, ... })` system-reminder API, the existing `bun build` artifact shape (`dist/index.js` only), the `dist/` build does not include TUI source.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@opencode-ai/plugin/tui` API undocumented beyond Magic Context. Field shape (`trigger` vs `value`) and behavior may have shifted since Magic Context's last pin | Pin the peer to a known-good version; verify the field name at implementation time (Unit 5); document the chosen field in `AGENTS.md`. Implementation-time spike if the API has materially changed. |
| `@opentui/*` is pre-1.0; SolidJS-on-opentui surface may shift | Pin to `^0.1.40` matching Magic Context's working baseline; do not auto-bump via Renovate without manual verification. |
| Raw `.tsx` export assumes OpenCode's TUI runtime compiles JSX on-the-fly | Verified by precedent (Magic Context does the same). Implementation-time gate in Unit 5: if loading fails, ship a build artifact. |
| `tsc --noEmit` may not resolve JSX element types under `jsx: "preserve"` + per-file pragma | Implementation-time gate in Unit 1: fall back to `jsx: "react-jsx"` + tsconfig `jsxImportSource` if needed. |
| `127.0.0.1` binding may fail on networks with IPv6-only loopback or strict firewall rules | Document the constraint in README. The TUI surfaces this as the spec'd RPC error state, not a crash. |
| `dialog.replace` may capture keybinds intended for the underlying list | Verified by precedent (Magic Context uses the same overlay pattern). Implementation-time gate in Unit 6/7. |
| RPC port collision with another local listener | Bind to ephemeral port (`0`); each call to `startRpcServer` gets a fresh port. Port-file race resolved by per-session path. |
| Cross-session token theft if port-file 0o600 perms regress | Test asserts `mode === 0o600` after write (Unit 3). Auth token defense-in-depth: even if perms regress, an attacker still needs the token to make calls. |
| Spawn-toast queue saturation at 10 concurrent delegations | Unverified; OpenCode's toast implementation may rate-limit. Implementation-time observation: if toasts drop, batch via a debounce. |
| Transitive dep conflicts from `@opentui/*` + `solid-js` | Verify at `bun add` time (Unit 1). If conflicts, escalate before downstream units begin. |
| Cancel-from-UI race with stdout buffer (post-kill JSONL events appended to registry) | Closed by the parser-status guard in the pre-TUI hardening plan; v0.2.0 assumes that's already shipped. |
| Modal interferes with active OpenCode work | Modal does not block input to the underlying session; Esc returns instantly. |
| OpenCode `Hooks` interface lacks dispose; cleanup is best-effort | `process.on('beforeExit'/'SIGTERM')` covers normal exits. Reaper covers SIGKILL leftovers. Upstream-issue follow-up to retire the workaround when a dispose hook lands. |

## Documentation / Operational Notes

See "Definition of Done" above. CHANGELOG is generated automatically by changesets from the Unit 1 changeset description.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-27-copilot-status-tui-requirements.md](../brainstorms/2026-04-27-copilot-status-tui-requirements.md)
- **Prerequisite plan:** [docs/plans/2026-04-27-002-fix-runtime-hardening-pre-tui-plan.md](2026-04-27-002-fix-runtime-hardening-pre-tui-plan.md)
- Related brainstorm research: [docs/research/copilot-cli-capabilities-2026-04-27.md](../research/copilot-cli-capabilities-2026-04-27.md)
- Related ideation: [docs/ideation/2026-04-27-copilot-delegate-v0.2.md](../ideation/2026-04-27-copilot-delegate-v0.2.md) (S1)
- Closed plan it builds on: [docs/plans/2026-04-21-copilot-delegate-plugin.md](2026-04-21-copilot-delegate-plugin.md)
- Magic Context working precedent: `node_modules/@cortexkit/opencode-magic-context/` and `node_modules/@cortexkit/opencode-magic-context-tui/`
- OpenCode plugin TUI docs: https://opencode.ai/docs/sdk/#tui
- Institutional learnings: `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md`, `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md`
