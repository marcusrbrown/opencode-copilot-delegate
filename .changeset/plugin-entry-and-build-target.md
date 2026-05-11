---
'opencode-copilot-delegate': minor
---

Harden the plugin entry's public surface and Node-loadability so the build artifact survives the same class of regression that bit Systematic in v2.5.0 and v2.12.1.

OpenCode's plugin loader treats every named export from a plugin entry point as a separate plugin factory and invokes it with `undefined` input. That contract has bitten upstream plugins twice with hours of downtime each; this PR institutionalizes the fix in three coordinated changes:

- **Helper moved out of the entry point.** `wireRpcServerCleanup` now lives in `src/lib/rpc-cleanup.ts`. The plugin entry exports only `default` and re-imports the helper internally. No behavior change — the helper's identity-once semantics and its single caller are byte-identical.
- **Build target switched to Node for the plugin entry.** `scripts/build.ts` now builds `src/index.ts` with `target: 'node'` so `dist/index.js` loads under plain Node ESM. The TUI entry stays on `target: 'bun'` because `@opentui/solid` is Bun-specific. The Node-loadable build is the prerequisite for the new CI gate (next bullet).
- **CI gate asserts the export shape on every PR.** A new step in `.github/workflows/ci.yaml` between `Build` and `Unit tests` runs `node --input-type=module -e "import('./dist/index.js').then(m => …)"` and exits non-zero if the entry exposes any export other than `default` or if `default` is not a function. The local test surface gets a matching assertion in `tests/package-exports.test.ts`. The gate's failure message references the v2.5.0/v2.12.1 regression class so future contributors can find the rationale.

Also documents the divergence rationale: this plugin keeps the `plugInOnce` singleton pattern (returns empty hooks on duplicate invocations) even though Systematic's PR #352 replaced that pattern with per-load registration. The constraint inverts here because this plugin's `doInit` binds a TCP port and writes a PID file — running `doInit` twice in the same process would race on those exclusive resources. `src/runtime/plugin-singleton.ts` and `src/lib/rpc-cleanup.ts` carry top-of-file JSDoc explaining the divergence with cross-references to https://github.com/marcusrbrown/systematic/pull/352.

No user-visible behavior change.
