---
title: "fix: Align OpenTUI with the V1 host and clear the brace-expansion advisory"
type: fix
status: completed
date: 2026-11-20
---

# fix: Align OpenTUI with the V1 host and clear the brace-expansion advisory

> **Outcome (2026-11-21):** Shipped in #568. Bun 1.4.5 does **not** honor nested override keys, and the global fallback dragged rimraf's 5.x copy down to 2.x. The version-scoped key `"brace-expansion@2": "^2.1.8"` worked; see `docs/solutions/best-practices/bun-version-scoped-override-for-transitive-advisory-2026-11-21.md`. #587 later moved `@opentui/*` to dev dependencies plus optional peers, so the advisory path is now dev-only, and the "shipped dependency tree" premise no longer holds. The dev pin is 0.8.4 (Renovate hold in #589).

## Overview

Upgrade `@opentui/core` and `@opentui/solid` from `0.2.7` to `0.4.5`, the version the OpenCode V1 host (`@opencode-ai/plugin` / `opencode-ai` 1.19.6) builds its own TUI against. Pin a single `@opentui/core` copy with an `overrides` entry. Clear the high `brace-expansion` advisory that reaches the shipped dependency tree through `@opentui/solid`. This lands in one coordinated PR that supersedes the stale #335 and #135. Both are closed once it merges. It is the first step before the dual-host V2 plan (`docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md`), which moves OpenTUI to the `>=0.8.4` line V2 requires.

## Problem Frame

- The plugin ships `@opentui/core`/`@opentui/solid` `0.2.7` in `dependencies`. The host's catalog pins `0.4.5` (anomalyco/opencode `v1.19.6` root `package.json`), and `@opencode-ai/plugin@1.19.6` declares optional peers `@opentui/core|solid|keymap >=0.4.5`. So the plugin sits below the host's declared floor.
- Two PRs have tried to close the gap and stalled. #335 (fro-bot, 0.4.5, CONFLICTING since main moved `solid-js` to 1.9.19 and regenerated `bun.lock` in #554). #135 (Renovate, `@opentui/solid` 0.4.3 only). Neither is mergeable as is.
- `bun audit` reports high GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7, plus moderate GHSA-q2hr-2g5m-vwhr, on `brace-expansion@2.1.4`. The path is `@opentui/solid > babel-plugin-module-resolver@5.0.2 > glob@9.3.5 > minimatch@8.0.7 > brace-expansion`. Every `@opentui/solid` release through 0.9.7 keeps that path, so upgrading alone does not clear it. Daily Fro Bot report #558 tracks it as an Agent Note.

## Requirements Trace

- R1. `@opentui/core` and `@opentui/solid` resolve to exactly `0.4.5`, with one `@opentui/core` copy in the install tree.
- R2. `brace-expansion` resolves to `>=2.1.8` (the latest 2.x, outside all three advisory ranges) on the `@opentui/solid` path, and `bun audit` no longer lists it there.
- R3. No behavior regression in the TUI half: `/copilot-status` opens, lists tasks, confirms cancel, and closes on Esc without the freeze recorded in `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md`.
- R4. All quality gates stay green: typecheck, lint, build, ESM export-shape smoke test, `test:unit`, `test:tui`, and `npm pack --dry-run` file list unchanged apart from versions.
- R5. #335 and #135 are closed with successor links. If Renovate later opens a split `@opentui/solid`-only PR, that triggers the grouping proposal under Deferred to Implementation.

## Scope Boundaries

- No move to OpenTUI `0.6+`. `0.6.0` removes `useThread` (used in about 20 test call sites) and makes `destroy()`/`suspend()` async. `0.8.x`/`0.9.0` change ScrollBox, zero-size node painting, and `zIndex` paint order. That move belongs to the V2 plan.
- No `solid-js` 2.x (major). `solid-js` stays on the 1.9 line (currently `1.9.19`).
- No host API changes (`@opencode-ai/plugin/tui` usage stays as is).
- No `@opentui/keymap` dependency. The host types import it, but adding a dependency is an ask-first change and runtime does not need it.

### Deferred to Separate Tasks

- OpenTUI `>=0.8.4` (likely `0.9.x`) for V2: `docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md`.
- Wall-clock-sensitive unit tests surfaced during #530 work (resume no-match window, tools timeout race, subprocess grandchild pid). This is a separate test-hygiene fix, not part of this upgrade. It is tracked in an issue to be opened before the V2 plan's CI matrix (Unit 5).

## Context & Research

### Relevant Code and Patterns

- `package.json`: `dependencies` (`@opentui/core`, `@opentui/solid`, `solid-js`), `overrides` (currently a `zod` entry, which security PR #556 raises to `^4.6.7`), and the `test:tui` script with `--preload @opentui/solid/preload`.
- `scripts/build.ts`: `@opentui/solid/bun-plugin` transform; `@opentui/core`, `@opentui/solid`, and `solid-js` are externals.
- `src/tui/components/confirm-card.tsx`, `src/tui/components/modal-list.tsx`, `src/tui/index.tsx`: use `KeyEvent`, `TextAttributes`, `TextRenderable`, `BoxRenderable`, `useRenderer`, `renderer.keyInput`, `requestRender()`, and JSX `<box>`/`<text>`. All of these are present and unchanged at 0.4.5.
- `src/tui/__tests__/*`: `testRender` with `useThread: false`, `captureCharFrame`, `mockInput`, and `@opentui/solid/runtime-plugin-support`. All are still valid at 0.4.5.
- #335's diff is the reference for the `overrides."@opentui/core"` pattern and the lockfile shape (`bun-ffi-structs 0.2.4`, new `linux-*-musl` binaries, `yoga-layout` removed). The host repo uses the same override pattern (`overrides: { "@opentui/core": "catalog:" }`).

### Institutional Learnings

- `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md`: never pass `api.ui.dialog.clear()` back into `dialog.replace(..., onClose)`. Report load errors upward before closing. Regression tests in `src/tui/__tests__/index.test.ts` and `modal-list.test.tsx` pin this.
- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md`: TUI failures must stay non-fatal to server tools. Run TUI tests through the preload path, and keep the package-export smoke test.

### External References

- anomalyco/opentui releases 0.4.5 → 0.9.7: there are no breaking-change sections between 0.4.5 and 0.5.17, and the first TS-visible break is 0.6.0.
- anomalyco/opencode `v1.19.6` root `package.json` catalog: `@opentui/core|keymap|solid 0.4.5`, `solid-js 1.9.10`.
- GitHub advisories GHSA-6j4f-fj2g-mc7p (`>=2.0.0 <2.1.5`), GHSA-qhr7-859c-m2p7 (`<2.1.6`), GHSA-q2hr-2g5m-vwhr (`<2.1.7`). `brace-expansion` 2.x latest is `2.1.8`.

## Prior-Art Survey

```json
{
  "schema_version": 2,
  "verdict": "extend",
  "scope": "package.json dependency/overrides surface, scripts/build.ts, src/tui/, open PRs #335 and #135",
  "freshness": {
    "vcs_reference": "origin/main@15b2a9a"
  },
  "budget": {
    "max_search_passes": 2,
    "max_candidate_inspections": 4,
    "exhausted": false
  },
  "candidates": [
    {
      "path_or_symbol": "PR #335 (chore/opentui-0.4.5)",
      "description": "Same target version and core override; used as the reference diff",
      "disposition": "insufficient",
      "insufficiency_reason": "Lockfile conflicts with main after #554; recreated from origin/main rather than rebased"
    },
    {
      "path_or_symbol": "PR #135 (renovate/opentui-solid-0.x)",
      "description": "Partial bump of @opentui/solid only, to 0.4.3",
      "disposition": "insufficient",
      "insufficiency_reason": "Bumps one of two coupled packages to a version below the host floor"
    },
    {
      "path_or_symbol": "package.json overrides",
      "description": "Existing overrides block (zod) that the brace-expansion and core pins join",
      "disposition": "extend"
    }
  ]
}
```

## Key Technical Decisions

- **Target 0.4.5 exactly, not the latest 0.9.7.** It matches the V1 host catalog and peer floor, needs zero test rewrites, and #335 already showed its gates passing on it. The jump to 0.9.x is deferred to the V2 plan, where the host requires it.
- **Pin `@opentui/core` with an override.** `@opentui/solid` depends on `@opentui/core` as a regular dependency. Without the pin, two core copies can coexist and `TextRenderable`/`KeyEvent` identities diverge. The host uses the same pattern.
- **Clear `brace-expansion` with an override, scoped to the 2.x line if Bun supports it.** Prefer a nested or package-scoped override that touches only the `@opentui/solid` path. Fall back to a global `brace-expansion` override only if the `rimraf` path's separate 5.x copy stays on 5.x (Unit 2 edge case). A global range must never force a node across majors.
- **Recreate rather than rebase #335.** Branch from current `origin/main` and regenerate `bun.lock` with `bun install`. Never hand-merge a lockfile. Close #335 (fro-bot, untouched) and #135 (Renovate) with links to the successor.
- **Changeset: `patch`.** It is a shipped dependency alignment and security fix with no feature change.

## Open Questions

### Resolved During Planning

- Does a newer `@opentui/solid` drop the vulnerable path? No. 0.4.5–0.9.7 all depend on `babel-plugin-module-resolver 5.0.2`, and its latest (5.0.3) still requires `glob ^9.3.3`.
- Does the plugin's OpenTUI copy matter at runtime, or does the host provide its own? For this plan's scope it doesn't matter: matching the host version removes the skew whichever copy loads. The general question is a V2 plan Unit 1 probe.

### Deferred to Implementation

- Whether Bun 1.4.5 honors nested override keys (for example `babel-plugin-module-resolver > … > brace-expansion`). Decide from `bun install` output and the resolved tree.
- Whether Renovate needs a `packageRules` grouping for `@opentui/*` to keep core and solid moving together. Decide after seeing whether Renovate proposes a split update post-merge. A config change to `.github/renovate.json5` is ask-first.

## Implementation Units

- [x] **Unit 1: Bump OpenTUI to 0.4.5 with a single core copy** (done: #568; the dev pin has since moved to 0.8.4 in #587 and #589)

**Goal:** `@opentui/core` and `@opentui/solid` at `0.4.5`, one core copy, lockfile regenerated from current main.

**Requirements:** R1, R4

**Dependencies:** #556 merged, so `overrides` doesn't hit a trivial `package.json` conflict.

**Files:**

- Modify: `package.json`, `bun.lock`
- Create: `.changeset/<name>.md` (patch)
- Test: `src/tui/__tests__/index.test.ts`, `src/tui/__tests__/modal-list.test.tsx`, `src/tui/__tests__/confirm-card.test.tsx` (existing; expected to pass unchanged)

**Approach:**

- Set both dependencies to `0.4.5` and add `overrides["@opentui/core"] = "0.4.5"`.
- Regenerate the lockfile and confirm the delta is limited to OpenTUI, its platform binaries, `bun-ffi-structs`, and `yoga-layout`.

**Patterns to follow:** #335's `package.json` diff, and the host's catalog override.

**Test scenarios:**

- Integration: `test:tui` passes through the `@opentui/solid/preload` path with no edits to test files (`useThread: false` is still accepted at 0.4.5).
- Integration: the regression tests for the re-entrant dialog close and load-error ordering (per the ui-bugs learning) still pass.
- Edge case: the resolved tree contains exactly one `@opentui/core` (no nested copy under `@opentui/solid`).

**Verification:** Typecheck, lint, build, the ESM smoke test (`['default']`), `test:unit`, and `test:tui` all pass. `npm pack --dry-run` lists the same files.

- [x] **Unit 2: Clear the brace-expansion advisory on the OpenTUI path** (done: #568, via the version-scoped override `brace-expansion@2`; see the Outcome note above)

**Goal:** No vulnerable `brace-expansion` on the shipped `@opentui/solid` path.

**Requirements:** R2

**Dependencies:** Unit 1 (same lockfile regeneration)

**Files:**

- Modify: `package.json` (`overrides`), `bun.lock`

**Approach:**

- Add the narrowest override Bun honors that lifts the 2.x node to `>=2.1.8`.
- Check that `rimraf`'s separate copy keeps its major.

**Test scenarios:**

- Happy path: `bun audit` no longer lists GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7, or GHSA-q2hr-2g5m-vwhr for the `@opentui/solid` path.
- Edge case: the `rimraf` dependency path resolves the same `brace-expansion` major as before.
- Integration: `bun run build` still runs the Solid Babel transform (`@opentui/solid/bun-plugin`), and `test:tui` passes. These prove the overridden `glob/minimatch` chain still works at build time.

**Verification:** `bun audit` shows the three advisories cleared on that path. The build and TUI tests are green.

- [x] **Unit 3: Live host check and supersede stale PRs** (done: #568 closed #335 and #135 as superseded. The live check on OpenCode 1.19.6 showed the TUI was already unstyled and unresponsive on `main`; #572 fixed that by rebuilding `/copilot-status` on host dialogs)

**Goal:** Prove the upgraded TUI against the real V1 host, then retire #335 and #135.

**Requirements:** R3, R5

**Dependencies:** Units 1–2 complete on the PR branch. The live check runs before merge, and the stale PRs are closed after it.

**Files:**

- None in the repository. Record the live-check results in the PR body before merge.

**Approach:**

- With OpenCode `1.19.6` (the `mise.toml` pin) and the plugin installed from the branch build, open `/copilot-status`. Navigate the list, open and confirm cancel, then press Esc from each view. Check the modal layout visually.
- After merge, close #335 and #135 with links to the successor PR. Watch for a split Renovate OpenTUI PR (R5).

**Test scenarios:**

- Test expectation: none. This is a manual live check of behavior the automated suites cannot cover, because they never run inside the host binary.

**Verification:** No freeze on Esc, no missing styling or layout regressions, and both stale PRs are closed with successor links.

## System-Wide Impact

- **Interaction graph:** TUI half only. The server tools, RPC server, and subprocess runtime don't import OpenTUI.
- **Error propagation:** TUI load failures must stay non-fatal to server tools (two-entrypoint learning). Nothing in this change alters that boundary.
- **Unchanged invariants:** `src/index.ts` exports only `default`; the `./tui` export shape stays as is; the RPC port-file contract is unchanged.

## Risks & Dependencies

| Risk                                                                                                 | Mitigation                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate `@opentui/core` copies break type identity                                                 | Core override, plus a resolved-tree check in Unit 1                                                                                                      |
| Host ships `solid-js 1.9.10`, we ship `1.9.19`; `@opentui/solid@0.4.5` peers exact `solid-js 1.9.12` | Same skew exists on main today. Accept the peer warning and keep watching it in the live check. The V2 plan's Unit 7 decides `solid-js` alignment with both hosts |
| Override does not reach the nested path in Bun                                                       | Fall back to a global override only if `rimraf`'s 5.x copy stays on 5.x. Otherwise stop and record the blocker in the PR for a maintainer decision                                    |
| Renovate reopens a split `@opentui/solid`-only PR                                                    | Watch after merge. Propose a grouping rule (ask-first config change) only if it happens                                                                  |

## Sources & References

- Related PRs/issues: #335, #135, #556 (security fix that raises the `zod` entry in `overrides`), #558 (daily report Agent Note on `brace-expansion`)
- Related past work: `docs/plans/2026-05-11-001-feat-plugin-contract-and-tui-api-resilience-plan.md`, recorded as completed. That plan hardened the TUI host-API dual path. This plan changes only the OpenTUI library version beneath it.
- External: anomalyco/opentui releases; anomalyco/opencode `v1.19.6` `package.json`; GitHub Advisory Database entries listed above.
