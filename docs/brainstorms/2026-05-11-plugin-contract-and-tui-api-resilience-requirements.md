---
date: 2026-05-11
topic: plugin-contract-and-tui-api-resilience
---

# Plugin contract and TUI API resilience

## Summary

Bring four structural improvements to `opencode-copilot-delegate` so the plugin survives OpenCode's TUI API migration (1.14.42+) and matches the plugin-entry-shape contract Systematic enforced in v2.12.2: TUI API dual-path migration, plugin entry default-only export, build target switch to Node, and a documented audit of the singleton design. Splitting across one or two PRs is acceptable (see Scope Boundaries); the technical dependencies only require keeping R3/R4/R5 together.

---

## Problem Frame

Three independent surfaces in the plugin's contract with OpenCode are currently fragile, plus one design that needs auditing against a sibling project's recent reversal.

**TUI API.** `api.command.register` was removed in OpenCode 1.14.42, broken through 1.14.43, and restored as a deprecated shim in 1.14.44+. The plugin's TUI entry at `src/tui/index.tsx:48` calls `api.command.register` unconditionally, and `package.json` pins `@opencode-ai/plugin` to `1.14.41` — the last version where this call works without a shim. Users on a newer OpenCode lose the `/copilot-status` slash command silently. The plugin's `peerDependencies` advertises `>=1.14.0`, over-promising compatibility against the actual code path.

**Plugin entry export shape.** `src/index.ts:27` exports `wireRpcServerCleanup`. OpenCode's plugin loader iterates every named export from a plugin module and invokes each as a plugin factory. The sister project Systematic shipped this exact anti-pattern twice: v2.5.0 (PR #309, `INTERNAL_AGENT_SIGNATURES`) and v2.12.1 (PR #352, `applyBootstrapContent`). The v2.12.1 case crashed the loader with `undefined is not an object (evaluating 'output.system.length')` and stripped every Systematic skill from the user's TUI. PR #355 fixed it by moving helpers to `src/lib/` and adding a CI Node-ESM smoke test that asserts the build artifact exports `default` only. This repo has the same anti-pattern with no CI gate.

**Build target.** `scripts/build.ts` builds the plugin entry with `target: 'bun'`, which emits `var __require = import.meta.require` at the top of `dist/index.js`. `import.meta.require` is Bun-only. End users run OpenCode (Bun), so the plugin loads fine in production — but `node --input-type=module -e "import('./dist/index.js')"` fails with `__require is not a function`. This blocks the export-shape CI gate the loader-anti-pattern fix needs, because that gate runs the build artifact under Node specifically to mimic a non-Bun consumer and catch shape regressions.

**Singleton design.** The plugin uses `plugInOnce` with an `onDuplicate → empty hooks` handler to prevent N-instance side effects. Systematic recently replaced this exact design with marker-based per-load registration (PR #352, finalized in PR #355). The replacement was correct for Systematic because its init is cheap (read JSONC, read markdown, return closures), and bootstrap idempotency could be encoded in a system-prompt marker. This repo's init is fundamentally different — it starts an RPC server on a localhost port and writes a PID file for orphan reaping — so per-load registration would spawn competing RPC servers and break orphan tracking. The design needs to stay, but the rationale for keeping it (and the divergence from Systematic) isn't documented anywhere a maintainer reading both codebases would see.

---

## Requirements

### R1. TUI API runtime feature-detect

The TUI plugin must register the `/copilot-status` slash command using `api.keymap.registerLayer({ commands, bindings })` when available, falling back to `api.command.register` otherwise. Both code paths register a single command titled "Copilot Status" with value `/copilot-status` that calls the existing `openList()` handler.

### R2. Pinned OpenCode version and compatibility floor

`devDependencies."@opencode-ai/plugin"` must move from `1.14.41` to a version `>= 1.14.44` (the version where `keymap.registerLayer` is canonical and `command.register` is restored as deprecated shim). The exact pin is the latest available `1.14.4x` (verified by feasibility review: `1.14.44` through `1.14.48` are published).

`peerDependencies."@opencode-ai/plugin"` should narrow from `>=1.14.0` to `>=1.14.41`. The dual-path code (R1) supports `1.14.41` (lower path) and `1.14.44+` (upper path). Versions `1.14.0`–`1.14.40` are NOT supported — the test suite never exercised them and the codebase has been pinned at `1.14.41` historically. Versions `1.14.42`–`1.14.43` are NOT supported either (the upstream gap where `command.register` was removed and `keymap.registerLayer` had bugs), but the dual-path code degrades gracefully on those by simply failing to register the slash command rather than crashing.

### R3. Plugin entry exports `default` only

`src/index.ts` must export `default` and nothing else. The `wireRpcServerCleanup` function must be relocated to a file under `src/lib/` (e.g., `src/lib/rpc-cleanup.ts`) and imported by `src/index.ts`. The existing test that uses `wireRpcServerCleanup` must follow the symbol to its new location. After build, `Object.keys((await import('./dist/index.js'))).sort()` must equal `['default']`.

### R4. CI export-shape gate

The CI workflow must include a Node-ESM smoke test that:
1. Imports `./dist/index.js` under Node (not Bun)
2. Asserts `Object.keys(m).sort()` equals `['default']`
3. On failure, throws an error whose message explains that the plugin entry must export `default` only and references the loader-iterates-named-exports behavior

The gate must run on every PR. The error message must be detailed enough that a future contributor or AI agent reading only the failure understands why the rule exists.

### R5. Plugin build target = node

`scripts/build.ts` must build the plugin entry with `target: 'node'` instead of `target: 'bun'`. The TUI entry may stay `target: 'bun'` because it imports `@opentui/solid/preload`, which is Bun-specific. After the change, `dist/index.js` must not contain `import.meta.require` and must load successfully under `node --input-type=module -e "import('./dist/index.js')"`.

### R6. Singleton design rationale recorded (implementation note, not a code behavior change)

The brainstorm doc (this file) is the primary record of the decision to keep `plugInOnce`. As an implementation hint for the next maintainer reading the code, a short header comment in `src/runtime/plugin-singleton.ts` must cross-reference Systematic's PR #352 / PR #355 with a one-paragraph explanation: RPC server bind + PID file orphan-reaping require single-init semantics, unlike Systematic's cheap idempotent init. This is an implementation note rather than a behavioral requirement — no code path changes.

### R7. Existing functionality preserved

After R1–R6 land, the plugin must:
- Load successfully in OpenCode 1.14.41 (current pin) and `>=1.14.44` (new target)
- Register all four tools: `copilot_delegate`, `copilot_output`, `copilot_cancel`, `copilot_resume`
- Show the `/copilot-status` slash command in the TUI
- Pass all existing unit and integration tests
- Pass `bun run typecheck` and `bun run lint`

---

## Acceptance Examples

### AE1. TUI registration on OpenCode 1.14.44+
**When** the TUI plugin loads under OpenCode 1.14.44 or later (`api.keymap.registerLayer` exists, `api.command.register` is a deprecated shim),
**then** registration uses `keymap.registerLayer({ commands: [{ namespace: 'palette', name: 'copilot-status', title: 'Copilot Status', ... }], bindings: [] })`, the `/copilot-status` command appears in the slash menu, and `onSelect`/`run` invokes `openList()`.
*Covers R1.*

### AE2. TUI registration on OpenCode 1.14.41
**When** the TUI plugin loads under OpenCode 1.14.41 (`api.keymap.registerLayer` is undefined, `api.command.register` is the only API),
**then** registration falls through to `api.command.register(() => [{ title: 'Copilot Status', value: '/copilot-status', slash: { name: 'copilot-status' }, onSelect: ... }])`, and the slash command continues to work.
*Covers R1, R2 (the lower-bound peerDependency).*

### AE3. CI gate catches a stowaway export
**When** a contributor adds `export const helper = ...` to `src/index.ts` and opens a PR,
**then** the CI Node-ESM smoke test fails with a message that includes the actual export list (e.g., `["default", "helper"]`), references the OpenCode loader behavior, and points to `src/lib/` as the correct home for helpers.
*Covers R3, R4.*

### AE4. Build artifact loads under Node
**When** `bun scripts/build.ts` runs after R5 lands and `node --input-type=module -e "import('./dist/index.js')"` is invoked,
**then** the import succeeds with exit code 0 and `Object.keys(imported).sort()` equals `['default']`.
*Covers R3, R5.*

### AE5. Duplicate factory invocation still produces empty hooks
**When** the same OpenCode process invokes the plugin factory twice (e.g., the plugin is listed in both user-level and project-level `opencode.json`),
**then** the first invocation runs `initializePlugin` and returns real hooks; the second invocation triggers `onDuplicate`, returns `{}`, and emits a warning log identifying the duplicate source.
*Covers the singleton behavior that motivates R6.*

### AE6. Singleton rationale is documented
**When** a maintainer reads `src/runtime/plugin-singleton.ts` or this brainstorm doc,
**then** they find a note cross-referencing Systematic PR #352 / PR #355 and explaining why `plugInOnce` stays in this repo.
*Covers R6.*

---

## Success Criteria

- `dist/index.js` loads in Node ESM and exports `default` only
- `/copilot-status` slash command works on OpenCode `1.14.41` and `>= 1.14.44`; on `1.14.42`–`1.14.43` the command fails to register but the plugin does not crash
- A future contributor exporting a helper from `src/index.ts` is blocked by CI before the regression can ship
- The singleton-vs-per-load decision is documented somewhere a maintainer working across both Systematic and this repo can find

---

## Scope Boundaries

**In scope (one or two PRs, planner's call):**
- TUI API dual-path migration (R1, R2) — *user-facing fix; can ship as its own PR ahead of the structural work if velocity matters*
- Plugin entry default-only export refactor (R3) — *must ship with R4 + R5*
- CI Node-ESM export-shape smoke test (R4) — *must ship with R3 + R5; requires adding a Node setup step to CI (the current pipeline is Bun-only)*
- Build target switch for plugin entry (R5) — *prerequisite for R4 (Node smoke test cannot run against a Bun-only artifact)*
- Singleton design rationale recorded (R6) — *implementation note; lands wherever the other R6-touching file lands, or in either PR*
- Regression-test verification (R7) — *applies to whichever PR(s) ship*

Dependencies: R3 → R5 (smoke test needs Node-loadable build) → R4. R1/R2 are independent. Planner may bundle all six in one PR for atomicity or split into (R1/R2) + (R3/R4/R5/R6/R7).

**Out of scope (deferred):**
- Per-load registration model port from Systematic — explicitly rejected (R6 captures the rationale)
- TUI entry build target changes — stays `target: 'bun'` because `@opentui/solid/preload` is Bun-specific
- Renaming any tools, adding new tools, or changing tool argument schemas
- Reworking the orphan-reaper, PID file layout, or RPC protocol
- Migration to OpenCode 1.15.x — that release is not GA at brainstorm time; if it lands during planning, the version pin in R2 may need updating but the API shape is unchanged

---

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| TUI API strategy | Dual-path runtime feature-detect with pinned-to-1.14.44+ tests | Magic Context's pattern is already validated against the same gap; pinning to 1.14.44+ tests against the canonical API while the fallback supports 1.14.41 users |
| Named export fix | Move helper to `src/lib/`, add CI gate | Mirror PR #355 exactly. The CI gate is what makes the constraint enforceable, not just documented |
| Build target | Plugin = `target: 'node'`, TUI = `target: 'bun'` | Plugin has no Bun-specific deps; TUI's `@opentui/solid/preload` is Bun-specific. Different runtimes, different targets |
| Singleton design | Keep `plugInOnce` + `onDuplicate → {}` | RPC server + PID file have N-instance side effects that the marker-based per-load model can't address |

---

## Dependencies / Assumptions

- OpenCode 1.14.44+ is available on npm at the time of implementation. If only 1.14.4{1,2,3} is published, R2 may need to land in a separate follow-up after the upstream release.
- `api.keymap.registerLayer({ commands: [...], bindings: [] })` accepts the command shape documented in Magic Context's commit `5fe1c4f` (commit on the magic-context repo). The published OpenCode types accept the runtime shape via open-ended command fields, and `@opentui/keymap` exposes `name`/`run` as the required fields.
- `target: 'node'` in `Bun.build` does not require additional polyfills for the plugin entry's current dep set (`@opencode-ai/plugin` is externalized; `fs`, `path`, `child_process` are Node built-ins).

---

## Outstanding Questions

1. **Should R4's CI gate fail the build, or just warn?** Recommended: fail. Same posture as Systematic's gate. Consistency across both repos matters more than the marginal flexibility of warning-only.
2. **Should the singleton's `onDuplicate → {}` change to `onDuplicate → realHooksClone()`?** Systematic's PR #335 explicitly returned `{}` from `onDuplicate` to prevent the OpenCode host from registering tools twice. The reasoning is unchanged here. Recommended: keep `{}`. Document the reasoning in R6.
3. **Does R5's build target switch break any existing test?** The test suite runs under Bun (`bun test`), so source-level tests are unaffected. The Node-ESM smoke test (R4) is new and depends on R5. Integration tests that exec `node` against `dist/index.js` (if any) would now pass instead of fail. Worth a grep during planning to confirm no test is asserting Bun-specific runtime behavior in `dist/index.js`.

---

## Implementation Hints (for planning)

This is a technical-architecture brainstorm, so implementation-shaped notes are appropriate:

- **F3 (TUI):** Mirror Magic Context's commit `5fe1c4f` exactly. Wrap registration in a helper function that takes `api` and the command spec. Tests can stub `api.keymap` and `api.command` to verify both paths.
- **F2 (named export):** `wireRpcServerCleanup` is referenced from `src/index.ts:103`. Move it to `src/lib/rpc-cleanup.ts`, update the import, follow the symbol in any test files that import it directly.
- **F1 (build target):** Change `scripts/build.ts:18` from `target: 'bun'` to `target: 'node'` for the plugin entry only. The TUI entry block at lines 22-33 stays untouched.
- **F4 (singleton):** Update `src/runtime/plugin-singleton.ts` header comment with the cross-reference to Systematic's PR #352/#355.
