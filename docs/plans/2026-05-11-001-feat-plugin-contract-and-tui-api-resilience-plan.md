---
title: 'feat: Plugin contract and TUI API resilience'
type: feat
status: completed
date: 2026-05-11
origin: docs/brainstorms/2026-05-11-plugin-contract-and-tui-api-resilience-requirements.md
---

# Plugin contract and TUI API resilience

## Overview

Bring `opencode-copilot-delegate` into compatibility with OpenCode 1.14.44+ (TUI API migration) and match the plugin-entry-shape contract Systematic enforced in v2.12.2 (PR #355). Five implementation units split across two PRs: one user-facing TUI fix that can ship independently, and a four-unit structural-correctness set that lands together because the CI gate (R4) depends on the Node-loadable build artifact (R5), which depends on the default-only export refactor (R3).

## Problem Frame

Three independent fragilities in the plugin's contract with OpenCode, plus one design that needs documented justification (see origin: `docs/brainstorms/2026-05-11-plugin-contract-and-tui-api-resilience-requirements.md` for full context):

- **TUI API:** `src/tui/index.tsx:48` calls `api.command.register`, which was removed in OpenCode 1.14.42 and restored as a deprecated shim in 1.14.44+. The devDep is pinned at `1.14.41` (the last version where this works directly). Users on a newer OpenCode lose the `/copilot-status` slash command silently.
- **Plugin entry exports:** `src/index.ts:27` exports `wireRpcServerCleanup` from the plugin entry. OpenCode's plugin loader iterates every named export and treats each as an additional plugin factory. Systematic shipped this anti-pattern twice (v2.5.0, v2.12.1) and finally enforced default-only exports in PR #355. This repo has the same anti-pattern with no CI gate.
- **Build target:** `scripts/build.ts` builds the plugin entry with `target: 'bun'`, which emits `var __require = import.meta.require` (Bun-only) at the top of `dist/index.js`. The plugin works in production (OpenCode runs Bun) but `dist/index.js` cannot load under Node, which blocks the export-shape CI gate.
- **Singleton design:** `plugInOnce` + `onDuplicate → empty hooks` stays — RPC server bind + PID file orphan-reaping have N-instance side effects the marker-based per-load model used in Systematic PR #352/#355 cannot address. Needs documented rationale so a maintainer working across both codebases sees the divergence is intentional.

## Requirements Trace

- R1. TUI plugin registers `/copilot-status` via `api.keymap.registerLayer` when available, falling back to `api.command.register` (see origin: R1)
- R2. devDep `@opencode-ai/plugin` bumped from `1.14.41` to `>= 1.14.44`; peerDep narrowed to `>=1.14.41` (see origin: R2)
- R3. `src/index.ts` exports `default` only; `wireRpcServerCleanup` relocated under `src/lib/` (see origin: R3)
- R4. CI workflow runs a Node-ESM smoke test asserting `Object.keys(m).sort() === ['default']` with explanatory error (see origin: R4)
- R5. `scripts/build.ts` builds the plugin entry with `target: 'node'`; TUI entry stays `target: 'bun'` (see origin: R5)
- R6. `src/runtime/plugin-singleton.ts` header comment cross-references Systematic PR #352/#355 with the divergence rationale (see origin: R6)
- R7. After all units land: plugin loads under OpenCode 1.14.41 and >=1.14.44, all four tools register, `/copilot-status` works, all existing tests pass (see origin: R7)

## Scope Boundaries

- TUI API dual-path migration (R1, R2)
- Plugin entry default-only export refactor (R3)
- CI Node-ESM export-shape smoke test (R4) including the Node setup step (CI is currently Bun-only)
- Plugin entry build target switch to `node` (R5)
- Singleton design rationale recorded as code comment (R6)
- Regression verification (R7)

### Deferred to Separate Tasks

- Per-load registration model port from Systematic: explicitly rejected; R6 captures the rationale
- TUI entry build target changes: stays `target: 'bun'` because `@opentui/solid/preload` is Bun-specific
- Renaming any tools, adding new tools, or changing tool argument schemas
- Reworking the orphan-reaper, PID file layout, or RPC protocol
- Migration to OpenCode 1.15.x: not GA at planning time

## Context & Research

### Relevant Code and Patterns

- `src/index.ts:27` — `wireRpcServerCleanup` named export (the anti-pattern; mirror `src/lib/` relocation pattern Systematic uses)
- `src/index.ts:103` — `wireRpcServerCleanup` call site (only consumer; will need import path update)
- `src/tui/index.tsx:1-67` — TUI plugin entry; lines 48-57 is the current `api.command.register` block to fork into dual-path
- `src/tui/__tests__/index.test.ts:88` — existing test stubs `api.command` — extend with `api.keymap` stub for dual-path coverage
- `src/runtime/plugin-singleton.ts` — `plugInOnce` + `onDuplicate` implementation (R6 target file)
- `src/runtime/rpc-server.ts` — RPC server bind that justifies single-init (referenced in R6 comment)
- `src/runtime/pid-file.ts` — PID file write that justifies single-init (referenced in R6 comment)
- `scripts/build.ts:15-20` — plugin entry build options; line 18 is `target: 'bun'` to flip to `'node'`
- `scripts/build.ts:22-33` — TUI entry build options; stays `target: 'bun'`
- `package.json:55` — peerDep range
- `package.json:60` — devDep pin
- `.github/workflows/ci.yaml` — CI workflow; add Node setup + smoke test step inside `jobs.check`, after the existing Build step and before Unit tests

### Institutional Learnings

- Systematic `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md` — the full pattern: plugin entries must export `default` only; the loader iterates named exports; CI gate prevents recurrence
- Systematic `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` — the singleton design's original justification (this repo's `plugInOnce` predates that doc; both share the model)
- Magic Context commit `5fe1c4f` — dual-path TUI registration reference pattern (verified by feasibility-reviewer)
- Systematic PR #355 (commit `183b459` on `main`) — the structural fix to mirror: relocate helper, update import path, harden CI smoke test

### External References

- OpenCode commits delimiting the TUI break: `1.14.42` (anomalyco/opencode#26053 "introduce opentui keymap as sole key/cmd engine"), `1.14.44+` (deprecated `command.register` shim restored)
- `@opencode-ai/plugin` published versions `1.14.44` through `1.14.48` available on npm (verified at planning time)

## Key Technical Decisions

| Decision | Rationale |
|---|---|
| TUI dual-path runtime feature-detect | Magic Context already validated this pattern across the 1.14.41/.42/.44 gap; lowest risk |
| Bump devDep pin to `>= 1.14.44`, narrow peerDep to `>=1.14.41` | Tests run against the canonical API; fallback supports the prior pinned version |
| Move `wireRpcServerCleanup` to `src/lib/rpc-cleanup.ts` | Matches Systematic PR #355's `src/lib/bootstrap.ts` relocation; clear `lib/` naming convention |
| CI Node-ESM smoke test asserts default-only | Mirrors Systematic's gate verbatim; consistency across both repos matters more than marginal flexibility |
| Plugin entry `target: 'node'`, TUI entry `target: 'bun'` | Plugin has no Bun-specific deps; TUI's `@opentui/solid/preload` is Bun-specific. Different runtimes, different targets |
| Keep `plugInOnce` + `onDuplicate → {}` | RPC server + PID file have N-instance side effects unaddressable by Systematic's per-load model. Returning `{}` (not real-hooks-clone) preserves the original PR #335 reasoning: prevents duplicate tool registration in the host |
| Split into 2 PRs | U1 (TUI) is user-facing and independent; PR-2 carries U2→U3→U4 as the structural dependency chain, with U5 riding along to document the singleton rationale and verify the full set. Separating lets the TUI fix ship faster without waiting on the structural set |

## High-Level Technical Design

```ts
const registerStatus =
  typeof api.keymap?.registerLayer === 'function'
    ? () => api.keymap.registerLayer({ commands: [...], bindings: [] })
    : typeof api.command?.register === 'function'
      ? () => api.command.register(() => [...])
      : () => {
          client.app.log(...)
          return () => {}
        }

const unregister = registerStatus()
api.lifecycle.onDispose(() => {
  rpc.dispose()
  unregister()
})
```

That sketch is the only non-obvious part: feature-detect the TUI API, keep the command payload identical, and preserve cleanup.

## Open Questions

### Resolved During Planning

- **CI gate fail or warn?** Fail. Same posture as Systematic's gate; consistency over flexibility.
- **`onDuplicate → {}` vs `realHooksClone()`?** Keep `{}`. PR #335's reasoning (prevent duplicate tool registration in the host) is unchanged.
- **Does the build target switch break any test?** Resolved by grep audit in U3 before applying the change. If any test execs `node` against `dist/index.js` with Bun-only expectations (e.g., asserting `import.meta.require` exists), the audit will surface it and the test gets updated alongside the build script change.

### Deferred to Implementation

None — every decision resolves at planning time.

## Implementation Units

### PR-1: TUI API dual-path migration

- [x] **Unit 1: TUI dual-path registration + version bump**

**Goal:** Make `/copilot-status` register across OpenCode 1.14.41, the 1.14.42–43 gap (best-effort graceful degradation), and 1.14.44+ (canonical `keymap.registerLayer` path).

**Requirements:** R1, R2, R7

**Dependencies:** None — independent of PR-2

**Files:**
- Modify: `src/tui/index.tsx` (replace lines 48–57's `api.command.register` block with a dual-path helper)
- Modify: `package.json` (devDep `@opencode-ai/plugin`: bump to latest `1.14.4x`; peerDep: narrow to `>=1.14.41`)
- Modify: `bun.lock` / `bun.lockb` (regenerate via `bun install --lockfile-only` after package.json edit)
- Test: `src/tui/__tests__/index.test.ts` (extend stubs to cover both registration paths)

**Approach:**
- Extract a helper inside `src/tui/index.tsx` (e.g., `registerCommands(api, openList)`) that takes the api object and the openList callback
- Inside the helper, runtime-feature-detect: `if (typeof api.keymap?.registerLayer === 'function')` → use `keymap.registerLayer({ commands: [...], bindings: [] })`; `else if (typeof api.command?.register === 'function')` → fall back to `api.command.register(() => [...])`; `else` → log a warning via `client.app.log` (or `console.warn` if client unavailable) and return
- The keymap path's command shape uses `namespace: 'palette'`, `name: 'copilot-status'`, `title: 'Copilot Status'`, `category: 'Copilot'`, `run() { openList() }` (mirrors Magic Context's exact field set from commit `5fe1c4f`)
- The command-register path's command shape preserves the current behavior verbatim: `title: 'Copilot Status'`, `value: '/copilot-status'`, `slash: { name: 'copilot-status' }`, `onSelect: () => openList()`
- The helper returns an `unregister` function that calls the path-appropriate cleanup. The existing `api.lifecycle.onDispose(() => { rpc.dispose(); unregister() })` block stays.

**Patterns to follow:**
- Magic Context `5fe1c4f` runtime feature-detect pattern (verified in brainstorm Phase 3.5)
- Existing TUI test pattern at `src/tui/__tests__/index.test.ts:88` (stubs the api surface)

**Test scenarios:**
- Happy path: when `api.keymap.registerLayer` exists and `api.command.register` does NOT, registration calls `keymap.registerLayer` exactly once with a `commands` array containing one entry whose `name === 'copilot-status'` and `run` callback invokes `openList()`
- Happy path: when `api.command.register` exists and `api.keymap.registerLayer` does NOT, registration calls `command.register` with a function that returns one entry whose `value === '/copilot-status'` and `onSelect` callback invokes `openList()`
- Edge case: when BOTH `api.keymap.registerLayer` and `api.command.register` exist (the 1.14.44+ shim era), the keymap path is preferred and `command.register` is NOT called
- Edge case: when NEITHER API exists, registration emits a warning log but does not throw, the TUI plugin still loads, and `api.lifecycle.onDispose` is still wired
- Integration: dispose callback unregisters via the path that was used to register (the test verifies the correct unregister was returned)

**Verification:**
- `bun test src/tui/__tests__/index.test.ts` passes with the new scenarios
- `bun run typecheck` passes against the new `@opencode-ai/plugin` types
- Manual verification optional but recommended: launch OpenCode with the local plugin path; confirm `/copilot-status` appears in the slash menu and opens the modal list

---

### PR-2: Plugin contract structural fixes

- [x] **Unit 2: Move `wireRpcServerCleanup` out of plugin entry**

**Goal:** Eliminate the named export from `src/index.ts` so the build artifact exposes `default` only. Prepares the codebase for U3/U4 to enforce the contract.

**Requirements:** R3 (partial — full enforcement comes in U4)

**Dependencies:** None within PR-2 (this is the foundation)

**Files:**
- Create: `src/lib/rpc-cleanup.ts` (the relocated `wireRpcServerCleanup` function and its closures)
- Modify: `src/index.ts` (remove the `export` keyword + function body at lines 27–59; import from `./lib/rpc-cleanup`)
- Modify: any test file that imports `wireRpcServerCleanup` from `src/index.ts` directly (grep first; if there is a test importing from the entry path, update its import to point at `src/lib/rpc-cleanup`)

**Approach:**
- Move the entire `wireRpcServerCleanup` function verbatim — including its `closeOnce`, `onBeforeExit`, `onSigterm` inner closures and the `process.on`/`process.once` wiring — into `src/lib/rpc-cleanup.ts`
- Export it as `export function wireRpcServerCleanup(...)` from the new file
- Update the import block in `src/index.ts` to add `import { wireRpcServerCleanup } from './lib/rpc-cleanup'`
- The call site at `src/index.ts:103` (`const closeRpcServer = wireRpcServerCleanup(rpcServer.close)`) stays unchanged — the function is now imported instead of defined inline
- No behavioral change to the function itself

**Patterns to follow:**
- Systematic PR #355's `src/lib/bootstrap.ts` relocation of `applyBootstrapContent` (commit `10660cd` in the Systematic repo, which became `183b459` on `main`)
- The `src/lib/` directory already exists in this repo (e.g., `src/lib/kill-tree.ts`, `src/lib/normalize-tool-arg-schemas.ts`) — follow that naming and structure

**Test scenarios:**
- Happy path: existing tests that exercise `wireRpcServerCleanup` indirectly through the plugin's RPC lifecycle continue to pass without modification
- Happy path: if any test imports `wireRpcServerCleanup` directly, the new import path resolves and the test's expectations are preserved
- Edge case: `bun run typecheck` succeeds — no orphaned import, no name collision in `src/lib/`
- Test expectation: no new unit tests required if the function's coverage is already adequate through integration paths; an explicit "behavioral surface didn't change" assertion is the existing test suite passing unchanged

**Verification:**
- `bun run typecheck` passes
- `bun run lint` passes
- All existing unit tests pass without modification
- `grep -rE "wireRpcServerCleanup" src/` shows exactly two locations: the definition in `src/lib/rpc-cleanup.ts` and the import + call in `src/index.ts`

---

- [x] **Unit 3: Switch plugin entry build target to `node`**

**Goal:** Make `dist/index.js` loadable under Node ESM (no `import.meta.require`) so U4's CI gate can run.

**Requirements:** R5

**Dependencies:** Unit 2 (the gate from U4 only adds value once the export shape is correct, which U2 produces)

**Files:**
- Modify: `scripts/build.ts` (change `target: 'bun'` to `target: 'node'` on the plugin-entry build options at line 18; TUI entry block at lines 22–33 stays unchanged)

**Approach:**
- Before changing the target, run `grep -rE "import.meta.(require|main)" src/` to verify no source code depends on Bun-specific `import.meta` extensions
- Also `grep -rE "Bun\." src/` to verify no source uses the Bun global (only test files should, if any)
- If grep reveals Bun-specific usage in the plugin entry's direct import graph, fix only the local swap needed for Node compatibility; if the change would ripple beyond that, stop and split a follow-up task
- Change `scripts/build.ts:18` from `target: 'bun',` to `target: 'node',`
- Run `bun scripts/build.ts` and verify `dist/index.js` no longer contains `import.meta.require`
- Run `node --input-type=module -e "import('./dist/index.js').then(m => console.log(Object.keys(m).sort()))"` and verify it loads with output `['default']` (U2 produces the default-only export; the load itself is what this unit enables)

**Patterns to follow:**
- Sister Systematic repo's `package.json` build script uses `--target bun` for a specific reason (`jsonc-parser` UMD resolution); this repo has no such dep, so `target: 'node'` is the correct default
- The TUI entry's `target: 'bun'` is justified by `@opentui/solid/preload` — keep that as-is

**Test scenarios:**
- Happy path: `bun scripts/build.ts` succeeds with no errors
- Integration: after build, `node --input-type=module -e "import('./dist/index.js')"` exits 0
- Integration: after build, `bun --input-type=module -e "import('./dist/index.js')"` still exits 0 (OpenCode runtime stays compatible)
- Edge case: `grep -n 'import.meta.require' dist/index.js` returns zero matches
- Edge case: existing tests under `tests/` and `src/**/__tests__/` still pass — they run under Bun where both targets work, so source-level coverage is unaffected

**Verification:**
- `dist/index.js` loads under Node ESM
- `dist/index.js` still loads under Bun
- All existing tests pass
- The TUI build artifact at `dist/tui/index.js` is unchanged (TUI target stayed `bun`)

---

- [x] **Unit 4: CI Node-ESM export-shape smoke test**

**Goal:** Block any future PR that re-introduces a named export from `src/index.ts` before it can merge.

**Requirements:** R3 (full enforcement), R4

**Dependencies:** Unit 2 (default-only export must exist for the gate to pass on this PR), Unit 3 (Node-loadable artifact required for the gate to run)

**Files:**
- Modify: `.github/workflows/ci.yaml` (add Node setup step + smoke test step inside `jobs.check`, after the existing Build step and before Unit tests; mirror Systematic's `.github/workflows/main.yaml` structure)

**Approach:**
- Add `actions/setup-node@<pinned-sha>` step with `node-version: 24` (matching Systematic's pin) between the existing build step and any subsequent test/release steps in the relevant job
- Add a "Verify plugin loads in Node.js" step that runs the same Node ESM smoke pattern Systematic uses, adapted to this repo's symbol set (no `plugin.config()` call — this plugin doesn't expose a `config` hook; instead exercise the `tool` hook surface and assert the four `copilot_*` tools are registered)
- The export-shape assertion is the gate's central value: `if (JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(['default'])) { throw new Error('...') }`
- Error message must explicitly:
  - Show the actual export list (`JSON.stringify(exportKeys)`)
  - Reference OpenCode's loader behavior ("iterates all named exports as plugin factories")
  - Point at `src/lib/` as the correct home for helpers
  - Reference the Systematic v2.5.0 + v2.12.1 incidents as cautionary precedent
- After the export-shape assertion, also assert `typeof m.default === 'function'` (covers the case where someone removes the default export entirely)
- Then exercise the plugin factory: `const plugin = await m.default({ client: { app: { log: async () => {} } }, directory: process.cwd() })` and assert `typeof plugin.tool.copilot_delegate.execute === 'function'`, same for `copilot_output`, `copilot_cancel`, `copilot_resume`

**Patterns to follow:**
- Systematic `.github/workflows/main.yaml` (build job, "Verify plugin loads in Node.js" step) — adapt the structure to this repo's CI but mirror the assertion logic verbatim

**Test scenarios:**
- Integration: CI smoke step passes on this branch (current code has default-only export + four tools registered)
- Integration: CI smoke step fails fast with the explanatory error if a contributor adds `export const helper = ...` to `src/index.ts`
- Integration: CI smoke step fails with a clear "default is not a function" error if `src/index.ts` removes the default export
- Integration: CI smoke step verifies all four `copilot_*` tools' `execute` is a function (catches accidental tool-surface regressions)

**Verification:**
- The new CI step passes on this PR's branch
- A manual local-dry-run of the smoke test (`node --input-type=module -e "..."` with the assertion code) passes against the current `dist/index.js`
- A manual local-dry-run with a deliberately-added second export fails with the expected error message
- PR-2 regression: after U2/U3/U4/U5 land, `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build` still pass against the built artifact

---

- [x] **Unit 5: Singleton design rationale**

**Goal:** Record the singleton-vs-per-load divergence rationale in the code where the singleton lives.

**Requirements:** R6

**Dependencies:** Unit 4 (the CI gate enforces R3/R4; this unit closes out R6)

**Files:**
- Modify: `src/runtime/plugin-singleton.ts` (add a header comment block at the top of the file, between the file's `import` block and its first exported symbol)
- No test changes

**Approach:**
- The header comment is one paragraph plus a cross-reference. Content:
  - State the design: `plugInOnce` returns real hooks on the first invocation and `{}` (empty hooks) on duplicates, so the OpenCode host registers tools exactly once per process even when the plugin is listed in both user-level and project-level `opencode.json`
  - State why this design stays in this codebase: `initializePlugin` binds an RPC server to a localhost port and writes a PID file under XDG state dir for orphan reaping. Both side effects must run once per process; per-load registration would compete for the port and corrupt orphan tracking
  - Cross-reference Systematic's contrasting model: PR #352 (`refactor(plugin): independent per-load registration with marker-based bootstrap idempotency`) and PR #355 (`fix(plugin): move applyBootstrapContent out of entry point to restore plugin load`). Note that Systematic's cheap idempotent init (read JSONC + read markdown + return closures) lets it use marker-based system-prompt idempotency in place of a singleton; this codebase's heavier init does not have an equivalent option
  - Link to Systematic's docs/solutions doc: `docs/solutions/integration-issues/opencode-plugin-factory-duplicate-registration-2026-05-04.md` (the original justification, written when both repos shared the model)

**Patterns to follow:**
- The existing comment in Systematic's `src/lib/bootstrap.ts` (lines 7–11) — short, explanatory, cross-references future-pain it prevents

**Test scenarios:**
- Test expectation: none — this is a documentation-only change with no behavioral surface
- Regression verification is covered by U4's PR-2 regression check

**Verification:**
- No additional verification beyond U4's PR-2 regression check

## System-Wide Impact

- **Interaction graph:** PR-1 touches the TUI registration surface only; PR-2 touches the plugin entry's module shape (which OpenCode's loader inspects), the build artifact, and CI. No interaction with the RPC protocol, the tool factories, or the agent discovery layer.
- **Error propagation:** The dual-path TUI registration introduces a new failure mode — neither `keymap` nor `command` API exists. The plan handles this with a warning log and graceful degradation (no slash command, but no crash). The CI gate's failure mode is a clear PR-blocking error.
- **State lifecycle risks:** The build target switch in U3 changes the runtime contract of `dist/index.js`. Existing Bun users see no change (Bun runs Node-target ESM fine). Theoretical Node users now actually work where they previously crashed. PID file and RPC server lifecycle are untouched.
- **API surface parity:** No public API changes. Plugin factory signature, tool surface, and TUI command name (`/copilot-status`) are preserved verbatim.
- **Integration coverage:** U1's "both APIs present" test scenario (the 1.14.44+ shim era) is the critical integration path. U4's CI gate IS an integration test — it loads the actual build artifact, not source.
- **Unchanged invariants:** The `plugInOnce` singleton's external behavior. The four `copilot_*` tools' argument schemas and execute semantics. The RPC server's port-binding and PID file layout. The TUI's modal UI flow once `/copilot-status` is invoked.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `target: 'node'` build introduces a regression in a transitive dep that uses Bun-specific resolution | U3's pre-change grep audit (`grep -rE "import.meta.(require|main)|Bun\."`) catches direct usage. For transitive deps, U3's verification step (run the built artifact under both Node and Bun) confirms compatibility. If a regression surfaces, U3 can revert to `target: 'bun'` and U4's gate becomes wait-only-on-default-export-shape (Node load deferred to a separate follow-up) |
| Magic Context's `keymap.registerLayer` command shape (with `namespace: 'palette'`) is not exactly what OpenCode 1.14.44+ wants | Feasibility-reviewer verified the shape against the current `@opencode-ai/plugin/tui` types. If types diverge by 1.14.50+, U1's test extension catches the mismatch before merge |
| The narrowed peerDep range (`>=1.14.41`) breaks downstream consumers pinned to `1.14.0`–`1.14.40` | The codebase has never tested against those versions; the narrowing aligns advertised support with actual support. If a real consumer surfaces, they upgrade their pin (a trivial change for them) |
| `wireRpcServerCleanup` relocation breaks a hidden import we haven't grepped | U2's verification step grep ensures exactly two refs to the symbol remain after the move. `bun run typecheck` catches any orphaned imports |

## Documentation / Operational Notes

- After both PRs merge, the changeset entry should call out: (a) the TUI compatibility expansion (1.14.44+ support added, 1.14.41 still supported), (b) the new CI gate as a structural-correctness addition for future contributors, (c) the Node-ESM loadability of `dist/index.js` (relevant for any future consumer outside OpenCode's runtime).
- No user-facing migration is required — all changes are backward-compatible for end users.
- The singleton comment in U5 should mention the date and the Systematic PR numbers so a future maintainer can trace the divergence rationale.

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-11-plugin-contract-and-tui-api-resilience-requirements.md`
- Related code: `src/index.ts`, `src/tui/index.tsx`, `src/runtime/plugin-singleton.ts`, `scripts/build.ts`
- Systematic PR #355 (commit `183b459` on `main`): the structural-fix reference
- Systematic PR #352 (commit `b27a9bc` on `main`): the per-load registration reference (which this codebase explicitly diverges from)
- Magic Context commit `5fe1c4f` on `master`: the TUI dual-path reference pattern
- OpenCode 1.14.42 anomalyco/opencode#26053: the TUI API break
- Systematic `docs/solutions/integration-issues/opencode-plugin-named-exports-break-loader-2026-05-11.md`: full pattern documentation
