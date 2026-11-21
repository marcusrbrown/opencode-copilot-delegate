---
title: "OpenCode V2 silently registered zero tools because of a V1-only zod schema patch"
date: 2026-11-21
category: integration-issues
module: opencode_runtime
problem_type: integration_issue
component: tooling
symptoms:
  - "TypeError: undefined is not an object (evaluating 'seen.ref') from z.object(args)['~standard'].jsonSchema.input()"
  - "V2 setup resolves and the plugin is active, but ctx.tool.list() has none of the four copilot_* tools"
  - "No error reaches the host or the user: tools.add logs the failed conversion and skips the tool"
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
  - dependencies
tags: [opencode-v2, dual-host, zod, standard-schema, tool-registration, globalthis-state, plugin-lifecycle, test-isolation]
---

# OpenCode V2 silently registered zero tools because of a V1-only zod schema patch

## Problem
`normalizeToolArgSchemas` is a V1 workaround. It patches each argument schema's `_zod.toJSONSchema` so that `.describe()` text survives the V1 host's separate zod copy on hosts older than 1.15.1. The patch breaks zod's own whole-object JSON Schema conversion, and that conversion is exactly how OpenCode V2 turns a tool's `input` into JSON Schema. V2's `tools.add` logs conversion failures and skips the tool instead of throwing. With the patch applied on both hosts, the plugin would have activated on V2 with **zero** tools and no visible error.

The bug was caught by a unit test before #582 merged, so it never shipped.

## Symptoms
- Converting a normalized argument shape the way V2 does throws `TypeError: undefined is not an object (evaluating 'seen.ref')`. The throw comes from zod v4's ref flattening in `to-json-schema`.
- V2 reports the plugin as active and `setup` resolves, but `ctx.tool.list()` contains no `copilot_*` tools.
- Nothing reaches the user. The host logs `Skipping invalid tool registration` and carries on. See `docs/research/opencode-v2-host-contract-2026-11.md` §4.

## What Didn't Work
- **Checking schemas with `z.toJSONSchema` on the raw args.** The unpatched schemas convert cleanly, so this check passes even when the real host path fails. Only the patched schema, wrapped in `z.object(...)`, throws.
- **Relying on V2 to surface registration errors.** `editor.add` does not throw on a bad schema, so a `try/catch` around `ctx.tool.transform` never sees the failure.
- **A planned dead end: a separate spec/port layer per host.** One V1-shaped `buildTools` plus a flag for the one host-specific transform turned out to be enough for both hosts.

## Solution
Normalization now runs only on V1. Before #582, the shared assembly in `src/index.ts` patched every tool unconditionally:

```ts
copilot_output: normalizeToolArgSchemas(createOutputTool()),
copilot_cancel: normalizeToolArgSchemas(createCancelTool()),
```

`buildTools` in `src/core/tools.ts` now takes a required `normalizeArgs` option:

```ts
const normalize = <T extends Parameters<typeof normalizeToolArgSchemas>[0]>(
  definition: T,
): T =>
  options.normalizeArgs ? normalizeToolArgSchemas(definition) : definition
```

`serverV1` passes `normalizeArgs: true`. `setupV2` passes `normalizeArgs: false` and wraps the untouched args for V2:

```ts
tools = buildTools({ client, directory, pidFilePath, normalizeArgs: false })
// ...
editor.add({ name, description: tool.description, input: z.object(tool.args),
  execute: (input, toolContext) => runTool(tool, input, toolContext, directory) })
```

V2 can drop a tool without an error, so `setupV2` checks registration positively afterwards:

```ts
await context.tool.reload()
const listed = new Set((await context.tool.list()).map((tool) => tool.id))
const missing = names.filter((name) => !listed.has(name))
if (missing.length > 0) stderrLog('warn', `tools failed to register: ${missing.join(', ')}`)
```

The guarding test is "registers exactly the four tools" in `tests/host-v2.test.ts`. It runs V2's real conversion on each registered input and compares the result with V1's per-argument output: properties, descriptions and required fields.

```ts
const v2Schema = standard.jsonSchema.input({ target: 'draft-2020-12' })
expect(v2Schema.properties).toEqual(v1Properties)
```

To confirm the test can fail, feed the V2 path normalized args. The test then fails with the `seen.ref` TypeError.

## Why This Works
On V1 hosts older than 1.15.1, each argument is serialized with the host's own zod copy, which cannot see the plugin's `.describe()` metadata. `attachJsonSchemaOverride` in `src/lib/normalize-tool-arg-schemas.ts` makes that per-argument call delegate to the plugin's zod instead.

V2 works differently. It treats the plugin's `z.object(...)` as a Standard Schema and asks zod itself to convert the whole object. zod's walker then reaches child nodes whose `_zod.toJSONSchema` has been replaced. Those nodes never get registered in the walker's `seen` map, so the ref-flattening pass dereferences `undefined`.

Leaving V2's schemas untouched fixes this. On V2 the schemas and the converter come from the same bundled zod, so the descriptions survive without any patch.

## Prevention
**Test the host's real conversion path, and assert registration positively.**
- Never assert only `z.toJSONSchema(rawSchema)`. Call `schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })` on the exact object you hand the host.
- At runtime, call `ctx.tool.reload()` then `ctx.tool.list()`, and diff the result against the expected names.

**Import host packages as types only, and prove it with a load test.**
- The default export is `{ id, server, setup }`, typed structurally as `server(input: never)` and `setup(context: never)`, so `dist/index.d.ts` names no host package.
- `src/lib/tool.ts` replaces V1's runtime `tool()` with a local identity function.
- `tests/host-free-build.test.ts` imports the bundle from a directory that holds only a `package.json`:

```ts
await writeFile(join(outdir, 'package.json'), '{"type":"module"}\n')
const mod = await import(pathToFileURL(join(outdir, 'index.js')).href)
expect(Object.keys(mod).sort()).toEqual(['default'])
```

**Keep process-wide state on `globalThis` behind `Symbol.for`, and test it with `?instance=` imports.** V1 evaluates the module once per config source or workspace, and V2 once per location. A module-level `Map` is therefore per instance, not per process. Use `processGlobal` (`src/lib/process-global.ts`) for the task registry, the PID-ledger write chains and the in-flight counters. Prove the sharing with separate module instances:

```ts
await import(`${join(SRC, relativePath)}?instance=${instance}`)
```

**Make each activation's cleanup idempotent, and release on any failure after acquire.** The process core is reference-counted (`acquireProcessCore` and `releaseProcessCore` in `src/runtime/process-core.ts`).
- A second cleanup call would drop another location's reference and tear the shared core down under it. Guard it with a `released` flag.
- A throw between acquire and returning the cleanup would leak a reference, so teardown would never run. `setupV2` releases the core when `buildTools` fails, and also when `tool.transform` fails. In the `transform` case it rethrows, so the host marks the plugin failed instead of showing it active with zero tools (#584).
- If `init` rejects, `acquireProcessCore` drops the reference and forgets the failed generation, so the next activation retries (#584).

```ts
let released = false
return async () => {
  if (released) return
  released = true
  active = false
  await registration?.dispose().catch(() => {})
  await releaseProcessCore()
}
```

**Reset `globalThis` state in both `beforeEach` and `afterEach`.** A V1 suite acquires the core and never releases it, so it leaves a live generation behind. The next suite's first acquire then silently reuses that generation. bun orders test files differently on macOS and on Linux CI, so this failure showed up only in CI.

```ts
beforeEach(() => { _resetProcessCore() })
afterEach(() => { _resetProcessCore() })
```

**Verify both hosts without a model.** This checks load and registration only. It is a separate layer from model-driven end-to-end tests (see `reliable-cli-integration-testing-2026-04-26.md`).
- **V1:** run `opencode serve`. `GET /path?directory=<ws>` loads the plugin, and `GET /experimental/tool/ids?directory=<ws>` should list the four `copilot_*` ids.
- **V2:** run `opencode serve` with `OPENCODE_SERVER_PASSWORD` set and basic auth, and pick a location with the `x-opencode-directory` header. Poll `GET /api/plugin`, because a fresh location returns `[]` for 1–3 s. V2 has no tool-list route, so load an observer plugin that calls `ctx.tool.reload()` and `ctx.tool.list()` and reports the ids.
- `tests/host-contract/run-host.sh <pin>` automates both against a clean tarball install. It runs as the required `Host contract matrix` CI check (#584).

## Related Issues
- `docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md` (Units 2–5)
- `docs/research/opencode-v2-host-contract-2026-11.md` (§4: zod as V2 `input`; §8: normalize is needed below 1.15.1)
- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md`, the earlier tool-registration and package-contract hardening
- `docs/solutions/best-practices/atomic-file-append-remove-o-excl-temp-file-2026-04-28.md`, the PID-ledger write chains that are now process-global
- `docs/solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md`, startup reaping, which is now the crash net behind V2's deterministic teardown
- `docs/solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md`, the same exactly-once discipline at the task layer
- Issues #530 (item 2: later workspaces got `{}`) and #567 (CI-only test flakiness, a different cause)
- PRs #578 (host-free `tool()`), #580 (`globalThis` state, per-directory hooks), #582 (V2 support and the `normalizeArgs` split), #584 (host-contract matrix and failure-path hardening)
