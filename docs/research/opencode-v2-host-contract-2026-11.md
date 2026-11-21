---
title: "OpenCode V2 host contract spikes (Unit 1 of the dual-host plan)"
date: 2026-11-20
type: research
---

# OpenCode V2 host contract spikes

Unit 1 of `docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md` ("Host contract spikes"). It answers each question in the plan's "Deferred to Implementation" list and checks the Host Facts table. Issue: #564.

## Method and environment

- **Probe projects** live outside the repo, under `/Users/mrbrown/.local/opt/opencode2-pilot/profile/tmp/opencode/v2-spikes/` (called `$SPIKES` below). Nothing was installed globally. `package.json` and `bun.lock` are untouched. No model credentials were used, and no model call was made.
- **V1 hosts** were installed with `bun add opencode-ai@<v>` into one directory per version, then run via the platform binary `node_modules/opencode-darwin-arm64/bin/opencode serve`. Versions: 1.3.3, 1.3.4, 1.3.17, 1.4.0, 1.14.40, 1.14.41, 1.14.49, 1.15.2, 1.19.6.
- **V2 host**: `@opencode/cli@2.3.2` (and `@opencode/plugin@2.3.2`), same method (`@opencode/cli-darwin-arm64/bin/opencode`). Only 2.3.2 was run. 2.3.0 and 2.3.1 were not.
- **Source** was read from a blobless clone of `anomalyco/opencode` at exact tags (`v2.3.2`, `v1.19.6`, `v1.14.41`, `v1.3.x`) via `git show <tag>:<path>` and `git archive`. File paths below are repo-relative to that tag.
- **Sandboxing**: each host ran with its own `HOME` and `XDG_{CONFIG,DATA,CACHE,STATE}_HOME` under `$SPIKES/sandbox/`.
  - The ambient shell exported `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which silently stops V1 loading project `opencode.json`. The harness unsets it. If a probe "doesn't load your plugin", check this first.
  - A first V1 instance takes about 10 s to boot (internal plugin and dependency work). Poll with a long `curl -m`.
- **V1 tool probing** uses `GET /experimental/tool/ids?directory=…` and `GET /experimental/tool?directory=…&provider=…&model=…`. Neither needs a model.
- **V2 probing** uses `opencode serve --port N` with `OPENCODE_SERVER_PASSWORD=spike`. Requests are authenticated as basic `opencode:spike`. A "location" is selected by the `x-opencode-directory` header (`packages/server/src/location.ts:73-79`). `GET /api/plugin` lists plugins and `GET /api/debug/location` lists live locations.
- **V2 plugin discovery**: `<project>/.opencode/plugin/<dir>/` where the dir has `index.js` or `server.js` at its root, or a `package.json` with `exports`. Resolution is in `packages/plugin/src/host.ts:15-66`. Configured plugin paths must be directories. A single file is only accepted from auto-discovery (`packages/core/src/config/plugin/source.ts`).
- **V2 TUI probing** ran `opencode --standalone` in a PTY.

Status vocabulary: **verified-by-probe** (a running host showed it), **verified-by-source** (read at the exact tag, not run), **unknown + fallback**.

## Summary

| #   | Question                                                       | Answer                                                                                                                                                | Status                                      |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | Lowest V1 version accepting default `{ id, server }`           | **1.3.4.** 1.14.41 already accepts it, so **no floor raise is needed**.                                                                               | verified-by-probe + source                  |
| 2   | V2 `setup` cardinality; reactivation vs cleanup                | `setup` runs **once per location per activation**. Reactivation **awaits** the prior cleanup. The module is re-evaluated per location.                | verified-by-probe + source                  |
| 3   | `session.synthetic` / `session.prompt` shapes; queue semantics | See §3. `queue` waits for the active turn. `steer` (the default) joins it. `synthetic` starts a turn when the session is idle unless `resume: false`. | verified-by-source (needs a model to probe) |
| 4   | zod 4 as V2 tool `input`                                       | **Works directly** (Standard Schema), zod ≥ 4.2. Registration is eager, and invalid tools are silently skipped.                                       | verified-by-probe + source                  |
| 5   | V2 `execute` context                                           | `sessionID`, `agent`, `messageID`, `id`, `progress`, `signal`. **No directory.**                                                                      | verified-by-source                          |
| 6   | V2 TUI process; `OPENCODE_SESSION_ID`                          | **Separate process** from the server in every mode. `OPENCODE_SESSION_ID` is **unset** in both.                                                       | verified-by-probe + source                  |
| 7   | Module identity (V2 and V1)                                    | Both hosts **share** `solid-js`, `@opentui/core` and `@opentui/solid` with externalized plugins. `PluginContextProvider` identity holds.              | verified-by-probe + source                  |
| 8   | Is normalize + `plugInOnce` still needed with bundled zod?     | normalize: **yes for hosts < 1.15.1**, no for ≥ 1.15.1. `plugInOnce`: **yes**.                                                                        | verified-by-probe + source                  |
| 9   | Removed OpenTUI APIs in `src/tui/**`                           | Only `useThread: false` in **tests** (20 sites). Components use none of the removed APIs.                                                             | verified-by-source + grep                   |

---

## 1. V1 loader floor for a default-exported `{ id, server }`

**Answer.** A default-exported object `{ id, server }` (plus extra keys such as `setup`) is accepted from **1.3.4** onward. `1.3.3` does not accept it. The repo's current peer floor, **1.14.41, already accepts it**, and so does 1.14.40. Nothing between 1.14.41 and 1.19.6 changes this logic.

**Status.** verified-by-probe on the floor (1.3.4) and one below (1.3.3). Also verified on 1.3.17, 1.4.0, 1.14.40, 1.14.41 and 1.19.6.

**Evidence.**

- Probe plugin (`$SPIKES/probes/q1/plugin-obj.mjs`) default-exports `{ id: 'spike-obj', server(input){…log…; return { tool: { spike_tool } } }, setup(){ log('setup() called') } }`. The host runs it from `file://…` in a project `opencode.json`.

| Host        | `server()` called                                                                           | `spike_tool` in `/experimental/tool/ids`                                                                                                     | `setup()` called |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1.3.3       | no                                                                                          | no. Serve log: `ERROR service=plugin … error=fn4 is not a function. (In 'fn4(input)', 'fn4' is an instance of Object) failed to load plugin` | n/a              |
| **1.3.4**   | yes (`directory=…/projects/q1`, input keys `client,project,worktree,directory,serverUrl,$`) | yes                                                                                                                                          | no               |
| 1.3.17      | yes                                                                                         | yes                                                                                                                                          | no               |
| 1.4.0       | yes                                                                                         | yes                                                                                                                                          | no               |
| 1.14.40     | yes                                                                                         | yes                                                                                                                                          | no               |
| **1.14.41** | yes (adds `experimental_workspace` to the input keys)                                       | yes                                                                                                                                          | no               |
| 1.19.6      | yes                                                                                         | yes                                                                                                                                          | no               |

- Source, `v1.3.3`: `packages/opencode/src/plugin/index.ts` iterates `Object.entries(mod)` and calls `fn(input)` on every export. An object throws a `TypeError`.
- Source, `v1.3.4`: `plugin/index.ts:74-76` adds `getServerPlugin()`, which accepts an object whose `"server" in value`. `index.ts:85-88` runs it through the legacy iteration.
- Source, `v1.14.41`:
  - `plugin/shared.ts:272-306` has `readV1Plugin` with `mode: "detect"`. An object with `id`, `server` or `tui` takes the V1 path. `server` must be a function.
  - `plugin/index.ts:95-99` calls `readV1Plugin(…, "server", "detect")` and then `plugin.server(input, options)`. `index.ts:73-77` and `index.ts:80-92` keep the legacy path for other shapes.
  - `readV1Plugin` has an identical md5 at v1.14.41, v1.15.0, v1.16.0, v1.17.0, v1.18.0, v1.19.0 and v1.19.6. The loader contract is stable across the whole supported range.
- **Constraint to carry into Unit 4.** `shared.ts:293-295` (v1.14.41, unchanged through 1.19.6) throws `Plugin … must default export either server() or tui(), not both` if the default has both `server` and `tui`. The **server** entry's default must therefore never carry `tui`. Extra keys such as `setup` are fine: they are ignored on V1, and `setup()` was never called.
- The legacy path iterates _every_ named export (index.ts:85). This is why `dist/index.js` must keep exporting only `default`.

**Impact on the plan.**

- **Contradicts** Key Technical Decisions → Peers and versions ("The V1 floor rises to the earliest version whose loader accepts an object default with `server`"), R1 ("from the new floor set in Unit 1"), and the Risks row "The V1 floor must rise above 1.14.41 — High likelihood".
- No floor raise is needed for the server half, so Unit 4's `package.json` floor edit and Unit 6's "raised V1 floor" README text can be dropped. Keep **>=1.14.41** (it is set by the TUI half; see the 2026-05-11 plan). The changeset should say "adds V2 support" without a floor bump.
- The server half would load as far back as 1.3.4. Nobody has tested tools, notify and RPC that far back, so don't advertise it.

---

## 2. V2 `setup` cardinality and reactivation vs cleanup

**Answer.**

- `setup` runs **once per location, per activation**. A location is a requested directory, and each location has its own plugin registry. Two directories on one server process give two `setup` calls in the same pid.
- The plugin **module is re-evaluated per location** (module state resets between locations), so process-wide state must live on `globalThis`.
- Reactivation **awaits** the previous cleanup. The new `setup` starts about 6 ms after the old cleanup finishes.
- An activation can be caused by things that never touch your plugin file:
  - an edit to your own file (new module instance, `setup#1` restarts);
  - **an edit to an earlier-ordered plugin** (same module instance, `setup#2`);
  - config changes.
- The same plugin id listed twice: the first wins. The second shows up as a failed plugin (`Duplicate plugin ID`) and its `setup` is never called. The location itself is unaffected.
- On server shutdown (SIGINT), every location's cleanup runs, concurrently, and the server waits for them.

**Status.** verified-by-probe (v2.3.2), plus source.

**Evidence.**

Probe plugin (`$SPIKES/probes/q2/index.js`): `Plugin.define`-shaped default `{ id: 'spike-v2', server(){…}, setup(ctx){…; return async () => { log('cleanup BEGIN'); await sleep(1500); log('cleanup END') } } }`.

- It carries an extra `server` key to prove V2 ignores unknown keys. `V1 server() called on V2` never appeared.
- It logs `process.pid`, `ctx.location.directory` and a module-evaluation counter.
- Two locations: `projects/q2a`, `projects/q2b`.

_Per location, same process, module re-evaluated._ Both locations ran in `pid=52495`:

```
[pid=52495] setup#1 (moduleInstance=1) location.directory=…/projects/q2a location.keys=directory,workspaceID,project …
[pid=52495] setup#1 (moduleInstance=2) location.directory=…/projects/q2b …
```
`GET /api/debug/location` returned both directories.

_Reactivation after editing the plugin file (q2a)_, with the edit at 21:04:34.3:

```
21:04:35.076Z cleanup#1 BEGIN (sleeping 1500ms)
21:04:36.578Z cleanup#1 END
21:04:36.584Z setup#1 (moduleInstance=4) location.directory=…/q2a      <- new module instance; starts 6 ms after cleanup END
```

_Reactivation after editing an unrelated earlier plugin_ (`aaa-other`, sorted before `spike`), with the edit at 21:05:15.3:

```
21:05:15.190Z cleanup#1 BEGIN
21:05:16.691Z cleanup#1 END
21:05:16.692Z setup#2                                                  <- same module instance (n incremented)
```

_Duplicate ids_ (q2b has `.opencode/plugin/spike` and `…/spike2`, both `id: 'spike-v2'`). `GET /api/plugin` shows:

```
{"id":"spike-v2","source":{"type":"local","path":".../spike"},"state":{"status":"active"}}
{"id":"spike-v2","source":{"type":"local","path":".../spike2"},"state":{"status":"failed","error":"Duplicate plugin ID: spike-v2"}}
```
`setup` ran once.

_Shutdown_ (SIGINT):

```
21:04:43.030Z cleanup#1 BEGIN   (location q2a)
21:04:43.033Z cleanup#1 BEGIN   (location q2b)
21:04:44.534Z cleanup#1 END
21:04:44.545Z cleanup#1 END
```

Source (`v2.3.2`):

- `packages/core/src/plugin.ts:315-320`: `Plugin.Service` is a `makeLocationNode`, so it is per location.
- `packages/core/src/plugin/supervisor.ts:248`: the supervisor is also a location node.
- `plugin.ts:103-198`, `activate`:
  - runs under a semaphore (`:117`);
  - computes the unchanged prefix of the ordered plugin list (`:122-126`);
  - **closes the old activation scope of every plugin after the first changed one, in reverse order, before loading the replacements** (`:140-153`, `:164`).
- `packages/plugin/src/promise/adapter.ts:673-677`: the plugin's `setup` and cleanup are an `Effect.acquireRelease`, and the cleanup is awaited as `Effect.promise(() => Promise.resolve(cleanup()))`. Only a function return counts as cleanup.
- `supervisor.ts:99-113`: duplicates keep the first occurrence and report later ones as `Duplicate plugin ID`.
- `plugin.ts:110` has a `Effect.die(Duplicate plugin ID…)`, but the supervisor removes duplicates before it, so it does not fire in the observed path.
- `supervisor.ts:205-206`: plugin source changes and module changes both trigger `activate`.
- `packages/core/src/plugin/module.ts:82-94`: the default is decoded with `Schema.Union([{id, effect}, {id, setup}])`. Excess keys are ignored, which is why `{ id, server, setup }` loads. `module.ts:135`: the revision is `JSON.stringify([operation, server version])`.

**Impact on the plan.**

- Confirms the plan's inferred Host Facts row ("`setup` per location") and the Process-core-on-`globalThis` decision. The module really does reset between locations.
- R5 ("whether or not the host awaits cleanup") can stay as defence in depth, but V2.3.2 **does** await it. The process core's "Acquire waits on any pending release" is still worth having for V2 builds nobody has probed (2.3.0 and 2.3.1).
- Unit 3 and Unit 4 test design: model `setup → cleanup → setup` as a routine event, not only a dev-reload edge case.
  - It happens when **another plugin earlier in the ordered list changes**.
  - The second `setup` can run in the **same module instance**, so module-level counters survive. After an edit to our own file they do not.
  - Process-core release and acquire must also tolerate **concurrent cleanups from several locations** (shutdown showed two BEGINs within 3 ms) and must not assume one cleanup in flight.
- Host Facts row "module cached per file digest" is only partly right: the module is re-evaluated for each location and for each edit to the file, but reused across reactivations triggered by other plugins.
- Host Facts row "Dedupe: by `id` within an instance" is right, but note the loser appears as a failed inventory entry, not a silent drop. This is cosmetic for us.

---

## 3. `session.synthetic` and `session.prompt` argument shapes; queue vs steer

**Answer.**

_Shapes._ Plugin `ctx.session` is `Pick<SessionApi, "prompt" | "synthetic" | "interrupt" | …>` (`packages/plugin/src/promise/session.ts:220-240`). Each method takes **one object that includes `sessionID`**:

```ts
// packages/client/src/promise/generated/types.ts:3555-3563
session.synthetic({
  sessionID: string,
  id?: string | null,
  text: string,
  description?: string | null,
  metadata?: Record<string, JsonValue>,
  delivery?: 'steer' | 'queue' | null,   // default 'steer'
  resume?: boolean | null,               // default true
})  // -> SessionInboxSynthetic { id, sessionID, time, type:'synthetic', payload:{text,description?,metadata?}, delivery }

// types.ts:3493-3512
session.prompt({
  sessionID: string, id?, text: string,          // plain text, not `parts`
  files?: [...], agents?: [...], skills?: [...],
  metadata?, delivery?: 'steer' | 'queue' | null, // default 'steer' (core/src/session/prompt.ts:52)
  resume?: boolean | null,
})  // -> SessionInboxUser
```
`prompt` creates a **user** message. `synthetic` creates a synthetic one. The V1 `parts: [{ synthetic: true }]` has no direct analogue on `prompt`.

_Semantics._

- **`delivery: 'steer'`** (the default for both methods): promoted at the next step boundary of an active turn.
  - `packages/core/src/session/inbox.ts:567-580`: the `"steer"` scope promotes steers only.
  - V2 itself uses steer for subagent reports (`session/execution/subagent-report.ts:94`).
- **`delivery: 'queue'`** is parked until the active turn ends, then runs as a fresh turn.
  - `inbox.ts:52-57` (`Promotable` doc comment: only the "input" scope falls through to one queued input).
  - `session/runner/llm.ts:75` and `:177`: a `queue` item is not promoted while a `steer`-scoped drain is running.
  - `session/run-coordinator.ts:135-140`: `wake()` during an active run only records `pendingWake`.
  - `run-coordinator.ts:115-116`: on settle, a pending wake starts a successor run, which promotes the queued item.
  - **So `queue` waits for the active turn and does not interrupt it.**
- **Does `synthetic` start a turn?** `core/src/session/synthetic.ts:47`: `if (input.resume !== false && !session.revert) yield* wake(sessionID)`. With the default `resume`, a synthetic on an **idle** session starts a model turn. This is the analogue of V1 `noReply: false`. With **`resume: false`** it is admitted to the inbox without waking the session. It is promoted at the next wake (for example the user's next prompt). This is the analogue of V1 `noReply: true`.
- The comment on the `experimental.idle` hook (`plugin/src/promise/session.ts:185-196`) confirms that notices admitted with `resume: false` "wait for the next wake".

**Status.** verified-by-source. A probe would need a configured model and an active session (a turn). The V1 comparison (`noReply`) is read from the plan, not re-probed.

**Impact on the plan.**

- **Contradicts** Host Facts ("`session.synthetic` … **no `noReply`**") and weakens the R6 / Key Decisions premise that V2 has no way to inject silently. `synthetic({ resume: false })` is the silent-notice analogue, so "no `noReply`" is only true of the _shape_, not the capability. Unit 4 should decide between:
  - (a) the plan's aggregated final injection, or
  - (b) per-completion `resume: false` notices (V1 parity), plus one waking injection for the last completion or a failure.

  Recommendation: keep (a) for the first release. It is the smaller change. Note (b) as a follow-up. Risk: a `resume: false` notice might sit in the inbox until a user prompt arrives, which is a different UX from V1.
- Key Decisions → V2 notifications: "whichever mechanism does not interrupt an active turn" resolves to **`delivery: 'queue'`**, with **`delivery` passed explicitly**, because the default is `steer` and steer joins the active turn.
  - Failures and cancellations ("inject immediately"): `session.synthetic({ sessionID, text, delivery: 'steer' })`. It lands at the next step boundary of an active turn and starts a turn if idle.
  - Final success: `session.synthetic({ sessionID, text, delivery: 'queue' })`. It waits for the active turn, then runs as a fresh turn.
  - `session.synthetic` is preferred over `prompt`: it does not look like a user message, and `description` and `metadata` are available.
- Unit 4's notification test: the argument object must include `sessionID` inside the same object.

---

## 4. zod 4 schema as V2 tool `input`

**Answer.** **Yes, a zod 4 schema works directly as `input`** (zod ≥ 4.2.0), including a zod copy bundled with the plugin that is separate from the host's. `tools.add` converts eagerly and silently skips tools that fail to convert (log only, no throw), so registration success must be asserted.

**Status.** verified-by-probe for registration plus source for execution-time validation. Execution was not driven (no model).

**Evidence.**

Probe (same plugin as §2, bundled `zod@4.6.7` from `$SPIKES/probes/q2/node_modules`, which the compiled host cannot share). Inside `ctx.tool.transform(tools => …)` it adds three tools, then calls `ctx.tool.reload()` and `ctx.tool.list()`:

| Tool         | `input`                                                                                    | In `tool.list()`?                                                  |
| ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `spike_zod`  | `z.object({ query: z.string().describe('the query'), n: z.number().int().optional() })`    | **yes**. `typeof input['~standard']` = `object`, `vendor` = `zod`. |
| `spike_json` | `{ type:'object', properties:{ q:{type:'string',description:'q desc'} }, required:['q'] }` | yes                                                                |
| `spike_bad`  | `'not-a-schema'`                                                                           | **no** (skipped)                                                   |

`tool.list()` returned the host's built-in tools (`patch, edit, glob, grep, …, subagent, webfetch, websearch, write`) followed by `spike_zod, spike_json`.

Source (`v2.3.2`):

- `packages/schema/src/tool.ts:61`: `ValueSchema = Schema.Codec | StandardSchemaV1 | JsonSchema.JsonSchema`.
- `packages/core/src/tool.ts:232-235`: `add` calls `commit`. `tool.ts:392-407` (`commit`) and `:421-443` (`register`) run `ToolDefinition.make(definition(tool))` inside `Result.try`. A failure is pushed to `editor.errors` and logged as `Skipping invalid tool registration` (`tool.ts:257`). It is not thrown.
- `packages/core/src/tool/runtime.ts:158-174`: `inputJsonSchema` → `standardJsonSchema`:
  - `:171` uses `schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })` when present;
  - `:172` falls back to `schema instanceof $ZodType` (the host's own zod copy — **fails for a bundled copy**);
  - `:173` otherwise throws `Schema vendor "zod" does not support JSON Schema conversion`.
- `runtime.ts:144-156`: `validateStandard` runs `schema['~standard'].validate(value)`, so input is validated by the plugin's own zod at call time.
- zod's `~standard.jsonSchema` appeared in **4.2.0**. Checked with `bun -e "import {z} from 'zod'; Object.keys(z.string()['~standard'])"`: 4.1.13 gives `validate,vendor,version`. 4.2.0 and 4.3.0 give `…,jsonSchema`. 4.6.7 gives `jsonSchema.input({target:'draft-2020-12'})` → `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"string"}`. The repo's `zod` is `^4.6.7`.

**Impact on the plan.**

- Key Decisions → Adapters: "Its `input` is JSON Schema generated from the same zod schema, **unless Unit 1 shows zod works directly**." It does, so Unit 4 can pass the core's zod schemas straight to `tools.add({ input })`. Validation then stays in zod, and no JSON Schema generation code is needed in the V2 adapter.
- Guard: keep a test that every spec appears in `ctx.tool.list()` after `reload()`, because a tool that fails conversion is _skipped silently_. Guard the zod floor (≥ 4.2) in `package.json` or a test, because a bundled zod < 4.2 would throw at the `$ZodType` fallback and drop the tool.
- Fallback if a future host stops accepting zod: `z.toJSONSchema(schema)` JSON Schema (the host also accepts plain JSON Schema, probed as `spike_json`).

---

## 5. V2 tool `execute` context

**Answer.** The promise-API `ToolContext` has:

- `sessionID`
- `agent` (agent id)
- `messageID`
- `id` (the call id)
- `progress(update): Promise<void>`
- `signal: AbortSignal`

It has **no directory or worktree**. Per-location data comes from the `setup` context: `ctx.location` has `{ directory, workspaceID, project }` (probe). Tools must be bound to the location's directory at registration.

**Status.** verified-by-source (the host's `Tool.Context`), with `ctx.location` verified by probe.

**Evidence.**

- `packages/schema/src/tool.ts:26-37`: `Context = { sessionID, agent, messageID, id, progress, cancel? }`.
- `packages/plugin/src/promise/tool.ts:11-20`: `ToolContext extends Omit<Tool.Context, 'progress'|'cancel'>` adding `signal: AbortSignal` and a promise `progress`.
- `packages/plugin/src/promise/adapter.ts:701-735` (`executePromiseTool`): `signal` is a **getter**. Reading it (spreading the context reads it too) opts the tool into cooperative stop. A user "stop" then aborts the signal, and "whatever the tool then returns or throws is still reported as the call's result". A tool that never reads `signal` is **interrupted** instead. The comment is at `tool.ts:12-17`.
- Probe: `ctx.location.keys=directory,workspaceID,project`, and `ctxKeys=app,location,options,agent,aisdk,command,credential,event,experimental,generate,model,provider,integration,mcp,permission,plugin,reference,rpc,skill,storage,tool,vcs,websearch,worktree,session,shell`. There is no `client` and no `$`.
- Contrast, V1 `v1.19.6` `packages/opencode/src/tool/registry.ts:148-153`: `pluginCtx = { ...toolCtx, directory: ctx.directory, worktree: ctx.worktree }`. That is the **instance** directory, not a per-call one.

**Impact on the plan.**

- The core port's "per-call context `{ sessionID, optional directory, abort }`" stays correct, but on V2 `directory` is **always absent**. It comes from `setup`'s `ctx.location.directory`, bound per location (one `setup` per location makes this safe). The "Directory precedence" decision holds as written: "per-call directory when the host supplies one; otherwise the directory bound at registration".
- `abort` maps to `ctx.signal`. Decide deliberately whether to read it:
  - Reading it opts into cooperative stop and keeps the result channel open.
  - Not reading it means the host interrupts the call, which skips the `finally` blocks.
  - The adapter should read `signal` once and forward it. Do **not** `{ ...ctx }` it carelessly.
- Also available: `agent` and `messageID`. This is useful for log correlation, but not needed.

---

## 6. V2 TUI process and `OPENCODE_SESSION_ID`

> **Resolved 2026-11-21 (#587):** the V2 server keys its port file by its own pid, and the V2 TUI reads `ctx.client.server.info().pid` on each request, with a hostname guard. The location directory, the server URL port and `ctx.rpc` were rejected. See `docs/solutions/best-practices/v2-tui-finds-server-port-file-by-server-pid-2026-11-21.md`.

**Answer.** The V2 TUI is **never in the server's process**, and `OPENCODE_SESSION_ID` is **not set** in either the TUI or the server process. It is injected only into the environment of child processes spawned by the shell tool. The current port-file discriminator `OPENCODE_SESSION_ID ?? String(process.pid)` (`src/runtime/rpc-server.ts:87`, `src/tui/rpc-client.ts:94`) therefore **cannot match** between a V2 server and a V2 TUI.

**Status.** verified-by-probe (standalone mode) plus source for the other modes.

**Evidence.**

Probe: `opencode --standalone` in a PTY, run in `projects/q6`. It loads a package plugin with `./` (server `setup`) and `./tui` (TUI `setup`) entries:

```
21:08:18.909Z [SERVER pid=66000] setup dir=…/projects/q6 OPENCODE_SESSION_ID=undefined
21:08:19.761Z [TUI    pid=65964 ppid=51382] setup OPENCODE_SESSION_ID=undefined versions bun=1.4.4
```
The server and TUI pids differ.

Source (`v2.3.2`):

- `packages/cli/src/services/standalone.ts:20,28`: standalone mode **spawns** a child, `opencode serve --stdio --port 0`.
  - `OPENCODE_PASSWORD` is passed in the child's env.
  - `stdin: 'pipe'` is the child's ownership lease.
- `packages/cli/src/services/server-connection.ts:41-70`: the default mode connects to a **managed background service**. `--server <url>` connects to a remote one. Both are separate processes.
- `packages/core/src/tool/plugin/shell.ts:426`: `invocation.env.OPENCODE_SESSION_ID = context.sessionID`. This is the **only** place the variable is set, and `:54` tells the model about it.
- `packages/tui/src/plugin/context.tsx:100`: the TUI loads a plugin's `./tui` entry when the **server** inventory lists it with `features.tui === true` (`plugin/src/host.ts:58` resolves `entry(['tui'])`). It is not discovered independently for combined packages.

**Impact on the plan.**

- Unit 8 needs a **new discovery mechanism** for V2. The plan already anticipated this ("`src/runtime/rpc-paths.ts` (only if discovery needs a V2 discriminator)"), so now it does.
  - The server and TUI pids differ, there is no session variable, and the managed service outlives any TUI.
  - Candidates, none verified here:
    - key the port file by something both sides can compute (the location directory; the server URL).
    - use V2's own plugin RPC (`ctx.rpc.register(definition, handlers)` on the server side, `packages/plugin/src/promise/rpc.ts`), which removes the loopback port file entirely on V2.
  - Treat as **unknown + chosen fallback**: key by location directory (the TUI knows `ctx.location` and the server's `setup` knows its own), pending a Unit 8 spike.
- The TUI half is only loaded for a package the server lists with `tui` in its features. The package's `./tui` export must keep existing alongside `.`, which it already does.
- Open risk: the managed background service is shared by many TUIs, so a loopback RPC port file per **location** (not per process) is the natural identity. Unit 3's process-core model already supports one RPC server per process with many locations.

---

## 7. Module identity

### 7a. V2 TUI: which `solid-js` and `@opentui/*` load; does `PluginContextProvider` identity hold?

**Answer.** An externalized `solid-js`, `@opentui/core` or `@opentui/solid` in a V2 TUI plugin resolves to the **host's copy**, not the plugin's. The `PluginContextProvider` / `usePlugin()` context identity holds.

The plan's Host Facts row ("V2 shares only `effect` and `@opencode/plugin`") is true of the **server-side** runtime modules only. The TUI also installs OpenTUI's runtime-plugin support.

**Status.** verified-by-probe (V2.3.2, host OpenTUI 0.8.4 and solid-js 1.9.17) plus source.

**Evidence.**

Probe: the TUI plugin (`$SPIKES/projects/q6/…/tui.js`) imports `solid-js`, `@opentui/core` and `usePlugin` from `@opencode/plugin/tui`. Its directory has **its own, different copies**: `solid-js@1.9.10` and `@opentui/{core,solid}@0.4.5` (symlinked from `probes/q7/o045/node_modules`), so a non-shared load would be an observably different module. After a 3 s delay it calls `ctx.ui.dialog.show(() => …)`, and the render function runs inside the host's reactive tree:

```
ctx.renderer instanceof plugin's own @opentui/core CliRenderer? true
dialog render: plugin-solid getOwner()!==null -> true; usePlugin() -> object
dialog render: own createContext default readable -> dflt
```

- `getOwner() !== null` can only hold if the plugin's `solid-js` is the same module instance that rendered the tree.
- `instanceof CliRenderer` holds against a package whose own copy is 0.4.5, so `@opentui/core` is the host's copy.
- `usePlugin()` returned the plugin context.
- Repeated with the plugin directory physically **inside `node_modules`** (`projects/q6/node_modules/tuispike-nm`, configured as `"plugins": ["./node_modules/tuispike-nm"]`): identical output.
- The plugin's `import.meta.resolve('solid-js')` returned the plugin copy's path. That call bypasses the runtime plugin, so don't read it as the loaded module.

Source (`v2.3.2`):

- `packages/tui/src/plugin/runtime-plugin-support.bun.ts:1-11`:

  ```ts
  ensurePluginRuntime()
  ensureRuntimePluginSupport({ additional: { '@opencode/plugin/tui': { Plugin, PluginContextProvider, usePlugin } }, preserve: provides })
  ```
- The OpenTUI default list (`@opentui/solid@0.8.4`, `scripts/runtime-plugin-support-configure.js:12-19`): `@opentui/solid`, `/components`, `/jsx-runtime`, `/jsx-dev-runtime`, `solid-js`, `solid-js/store`. Plus the core specifiers `@opentui/core` and `@opentui/core/testing` (`@opentui/core@0.8.4/runtime-plugin.js`, `isCoreRuntimeModuleSpecifier`).
- `packages/plugin/src/runtime-modules.ts:7`: `runtimePackages = ['effect', '@opencode/plugin']` is only the server list, for the host's `build.module` registrations.
- `packages/plugin/src/tui/solid.ts:1-19`: `PluginContextProvider` / `usePlugin` live in the host's `@opencode/plugin` and use the host's `solid-js`, so context identity is the host's by construction.
- `packages/tui/src/plugin/api.tsx:1,119`: the host wraps every dialog and registered render in `PluginContextProvider`.
- Rewrite rules (`@opentui/core runtime-plugin.js` header, both 0.4.5 and 0.8.4): non-`node_modules` source files are rewritten immediately. `node_modules` files are rewritten only if they are ESM (`type: module`) and (transitively) import a runtime specifier. Default `nodeModulesRuntimeSpecifiers: true`.

**Caveat.** This only shares what stays an **external import**. A plugin whose bundler inlines `solid-js` gets its own copy, and its signals do not track in the host's renderer. `scripts/build.ts` already externalizes `@opentui/core`, `@opentui/solid`, `solid-js`, and `@opencode-ai/plugin/tui` for the TUI build. Keep that.

### 7b. V1 1.19.6: what does `@opentui/solid/runtime-plugin-support` share by default?

**Answer.** Read at the version V1 1.19.6 uses (**`@opentui/solid@0.4.5`**, `solid-js@1.9.10`; `package.json:43-45,92` at tag v1.19.6): `@opentui/core` and `@opentui/core/testing`, `@opentui/solid`, `@opentui/solid/components`, `@opentui/solid/jsx-runtime`, `@opentui/solid/jsx-dev-runtime`, `solid-js`, `solid-js/store`. Same list as 0.8.4, so the host's copy wins for externalized imports. The V1 TUI api carries no `PluginContextProvider` concept, so there is no context-identity question.

**Status.** verified-by-probe (1.19.6) plus source read from the installed npm packages.

**Evidence.**

- `@opentui/solid@0.4.5/scripts/runtime-plugin-support-configure.js:12-19` has the same `defaultRuntimeModules` object as 0.8.4. `0.8.4` adds only the `preserve` option (`:23-29`). `runtime-plugin-support.js` just calls `ensureRuntimePluginSupport()`.
- Probe: `opencode` 1.19.6 TUI in a PTY with a `tui.json` plugin. The plugin has its own `solid-js@1.9.10` and `@opentui/core@0.4.5` copies:

  ```
  [V1 TUI pid=74971] tui() called; api keys=app,attention,command,keys,keymap,mode,route,ui,tuiConfig,kv,state,theme,client,event,renderer,slots,plugins,lifecycle; OPENCODE_SESSION_ID=undefined
  api.renderer instanceof plugin's own @opentui/core CliRenderer? true
  dialog render: plugin-solid getOwner()!==null -> true
  ```
- Not probed: V1 with the plugin inside `node_modules`. The source rewrite rules cover it (see 7a).

**Impact on the plan (7a and 7b).**

- **Contradicts** Host Facts "TUI module sharing (V2): Shares only `effect` and `@opencode/plugin`; the plugin's own `solid-js`/`@opentui/*` load (context-identity risk)". On V2 they share, and the identity risk is **retired** for externalized imports. Update the Risks row "Solid/OpenTUI context identity breaks the V2 TUI" to Low.
- Unit 7: the "decide `solid-js` alignment with both hosts" question is now low-stakes. **Both hosts load their own `solid-js`/`@opentui/*` over the plugin's copy** (V1 0.4.5 / 1.9.10, V2 0.8.4 / 1.9.17), so the plugin's pinned version affects mainly its **types and tests**, not runtime. The remaining runtime question is API compatibility: code written against 0.9 APIs runs on V1's 0.4.5 renderer. That still needs the live V1 Esc check Unit 7 already lists.
- Do not bundle `solid-js` or `@opentui/*` into `dist/tui`.
- The Phase 2 "blocked on OpenTUI `>=0.8.4` and the Solid context-identity question" gate loses its second half.

---

## 8. Is `normalizeToolArgSchemas` + `plugInOnce` still needed with bundled zod (V1)?

**Answer.**

- **`normalizeToolArgSchemas` (the `_zod.toJSONSchema` override): still needed on hosts older than 1.15.1**, and so on the declared floor 1.14.41. It is **not needed on ≥ 1.15.1**, where the host copies descriptions itself (see the table below).
- Repointing it at the plugin's own bundled zod works. The same override technique restores descriptions on every host tested.
- **`plugInOnce` is unaffected by the schema source** and is still needed. V1 calls `server()` once per config source even when the plugin id is identical.

**Status.** verified-by-probe (4 hosts, plus duplicate-call probe on 2 hosts) plus source.

**Evidence.**

Probe (`$SPIKES/probes/q8/plugin.mjs`): a V1 plugin with the plugin's own `zod@4.6.7` (not `tool.schema`) and no import of `@opencode-ai/plugin`. It returns two tools whose `args` carry `.describe('… DESC from bundled zod')`:

- `spike_plain` uses the schemas as-is.
- `spike_patched` first applies the same override as `src/lib/normalize-tool-arg-schemas.ts`, but backed by the bundled `z.toJSONSchema`.

`GET /experimental/tool?provider=anthropic&model=claude-sonnet-4-5` gives these `properties` (excerpt):

| Host    | `spike_plain`                                         | `spike_patched`                                                         |
| ------- | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| 1.14.41 | `"query":{"type":"string"}`, **descriptions dropped** | `"query":{"type":"string","description":"QUERY DESC from bundled zod"}` |
| 1.14.49 | **descriptions dropped**                              | descriptions kept                                                       |
| 1.15.2  | descriptions **kept**                                 | descriptions kept                                                       |
| 1.19.6  | descriptions **kept**                                 | descriptions kept                                                       |

- The patched `n: z.number().int()` additionally emits `"type":"integer","minimum":-9007199254740991,"maximum":9007199254740991` (zod's safe-integer bounds). That is cosmetic, but a Unit 2 snapshot should expect it.
- 1.15.0 and 1.15.1 could not be installed (the `opencode-ai` postinstall failed). The boundary is therefore bracketed from source rather than probe.

Source:

- `v1.14.41` `packages/opencode/src/tool/registry.ts:122-129`: `fromPlugin` does `z.object(def.args)` and annotates it with `ZodOverride` for the LLM schema. There is no metadata collection.
- `v1.15.0`: no `zodMetadataRegistry`. `v1.15.1` `registry.ts:420-428`: `z.toJSONSchema(schema, { io: 'input', metadata: zodMetadataRegistry(schema) })`. `v1.19.6` `registry.ts:374-407`: `zodMetadataRegistry` walks the foreign schema and re-registers `.description` and `.meta()` in the **host's** zod registry. That is why a plugin-bundled zod no longer loses descriptions. This boundary is bracketed by the source greps and by probes at 1.14.49 (loses) and 1.15.2 (keeps).
- `normalizeToolArgSchemas` itself: `src/lib/normalize-tool-arg-schemas.ts:43-62` hooks `_zod.toJSONSchema`, which older host serializers call first.

Duplicate factory calls (the `plugInOnce` half): plugin id is identical, specifiers differ.

- User-level config lists `file://…/plugin.mjs`. Project config lists `file://…/plugin-alias.mjs` (a symlink to the same file).
- 1.14.41: `server()` logged **twice** with the same timestamp. 1.19.6: also twice.
- The **same specifier** listed in both user and project config was de-duplicated by the host's config merge (one call).
- Conclusion: V1 does not de-duplicate by plugin `id`. A duplicate arrives whenever two different specifiers resolve to this plugin (a package name plus a path, or an `@version` suffix).

`docs/research/copilot-memory-experiment-2026-05-03.md:61-79` ("DUAL pattern") is a stored-memory _claim_, not a measurement. It says "Either alone is insufficient". That is now measured per half:

- The schema half's necessity depends on host version (above).
- The dedupe half is independent of zod and still needed.

**Impact on the plan.**

- Unit 2 ("`normalizeToolArgSchemas` is re-pointed at the bundled zod") is **confirmed and needed** for the supported floor. Keep the patch, applied only in the V1 adapter, using the bundled `z.toJSONSchema`. Optionally skip it when the host is ≥ 1.15.1, but that needs version detection and buys nothing. Leave it unconditional.
- Unit 2's test scenario "the V1 host's JSON Schema for each tool keeps the argument descriptions" should run against the **floor (1.14.41)** to prove the patch, not only against 1.19.6, where it would pass without the patch.
- Unit 3 (dedupe per directory) is confirmed.
- Update the research doc's DUAL claim when Unit 2 lands.

---

## 9. OpenTUI 0.6–0.9 removed APIs in `src/tui/**`

**Answer.** Only **`useThread`** is used, and **only in tests** (20 call sites). `src/tui/index.tsx` and `src/tui/components/*` use none of the removed APIs. There are no `h()` or `Box()` vnode factories, no `ScrollBox` / `<scrollbox>`, no `zIndex`.

**Status.** verified-by-source (grep) plus type declarations checked at 0.5.0, 0.6.0, 0.7.0, 0.8.0, 0.8.4 and 0.9.7.

**Evidence.**

- `grep -rnE "useThread|\bh\(|\bBox\(|ScrollBox|scrollbox|zIndex|z-index|\bText\(|\bSpan\(" src/tui` finds only these `useThread: false` options (all passed to `testRender`):
  - `src/tui/__tests__/index.test.ts`: 343, 396, 542
  - `src/tui/__tests__/modal-list.test.tsx`: 244, 265, 305, 344, 384, 429, 466, 500
  - `src/tui/__tests__/confirm-card.test.tsx`: 140, 189, 232, 266, 322, 371, 410, 455, 499
- JSX intrinsics used in components: `<box>` ×4 and `<text>` ×19 only (`grep -rhoE "<(box|text|scrollbox|…)\b" src/tui`).
- Imports used by components: `type KeyEvent`, `TextAttributes`, `type TextRenderable`, `type BoxRenderable` from `@opentui/core`; `useRenderer` from `@opentui/solid`; `onCleanup` from `solid-js`. The renderer calls they make: `renderer.requestRender()`, `renderer.keyInput.on/off('keypress')`. Both calls exist in 0.4.5, 0.8.4 and 0.9.7 `renderer.d.ts`.
- `testRender` uses: `renderOnce`, `captureCharFrame`, `captureSpans`, `renderer.idle()`. All exist in `@opentui/core/testing/test-renderer.d.ts` at 0.4.5, 0.8.4 and 0.9.7.
- **Where `useThread` went**: it is in `renderer.d.ts` at `@opentui/core` 0.5.0 (4 occurrences) and 0.4.5, and **absent from 0.6.0 onward** (0.6.0, 0.7.0, 0.8.0, 0.8.4 and 0.9.7 all have 0). So the option was removed in **0.6.0**.
- `renderer.destroy(): void` is still synchronous in the type declarations at 0.8.4 and 0.9.7. The 0.9.7 declaration has "Await after destroy() before closing stdout or calling process.exit()" at `renderer.d.ts:256`, so the plan's "make `destroy` async" item (Unit 7) refers to _awaiting a post-destroy finalization_, not a changed signature. Not run-tested.
- Not run-tested: the existing `test:tui` suite under 0.8/0.9. Only declarations and greps were checked. Unit 7 owns that.

**Impact on the plan.**

- Confirms Unit 7's file list and its "remove `useThread`" step: **tests only**. No component changes are forced by API removal.
- Components need no migration for the V2 `>=0.8.4` peer. Unit 7's layout-snapshot risk (0.8.1/0.8.2 zero-size and wrap changes) remains the real exposure and is a render-output risk, not an API risk.

---

## Plan decisions the findings contradict or change

| Plan text                                                                                                                                                         | Finding                                                                                                                                                                                 | Unit |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Peers: "V1 floor rises to the earliest version whose loader accepts an object default with `server`"; R1 "new floor"; Risk "floor must rise above 1.14.41 (High)" | The loader accepts it from **1.3.4**. 1.14.41 already works, so **no raise**. Drop the floor edits and the README "raised floor" text.                                                  | 4, 6 |
| Host Facts, V2 TUI: "Shares only `effect` and `@opencode/plugin`; plugin's own `solid-js`/`@opentui/*` load"                                                      | V2's TUI also shares `solid-js`, `solid-js/store`, `@opentui/core`, `@opentui/solid` (+ components, jsx runtimes) and `@opencode/plugin/tui`. Identity holds. Retire the identity risk. | 7, 8 |
| Host Facts, V1: "default list unread"                                                                                                                             | Read and probed: the same default list as V2.                                                                                                                                           | 7    |
| Host Facts: V2 `session.*` has "**no `noReply`**"; R6 degradation                                                                                                 | `synthetic({ resume: false })` is the silent analogue. `delivery` defaults to `steer`, so notify code must set `delivery` explicitly.                                                   | 4    |
| Key Decisions: V2 notification mechanism "`session.synthetic` or `prompt({ delivery: queue })`, whichever does not interrupt"                                     | `delivery: 'queue'` waits for the active turn. `steer` (the default for both) joins it. Use **synthetic** with explicit `delivery`.                                                     | 4    |
| Adapters: V2 `input` "is JSON Schema generated from zod, unless Unit 1 shows zod works directly"                                                                  | zod ≥ 4.2 works **directly**. Pass the zod schemas through, and add a `tool.list()` registration assertion plus a zod floor guard.                                                      | 4    |
| Host Facts: V2 "module cached per file digest"                                                                                                                    | The module is re-evaluated **per location** and per file edit, but reused across reactivations caused by other plugins.                                                                 | 3, 4 |
| R5 "whether or not the host awaits cleanup"                                                                                                                       | V2.3.2 **does** await it. Keep the guard as defence in depth. Add concurrent-multi-location cleanup to the Unit 3/4 tests.                                                              | 3, 4 |
| Unit 2: "`normalizeToolArgSchemas` is re-pointed at bundled zod" (re-verify)                                                                                      | Verified and **needed on < 1.15.1** (the floor). Run the description test on 1.14.41.                                                                                                   | 2    |
| Unit 8: V2 TUI discovery via the existing port-file discriminator                                                                                                 | `OPENCODE_SESSION_ID` is unset in V2 and the TUI is a different process from the server. A **new discriminator** (or V2 RPC) is required.                                               | 8    |
| "Directory precedence … or the V2 location" (per-call context)                                                                                                    | V2 `execute` has **no per-call directory**. Only the `setup`-time location. Consistent with the plan, but the core port's per-call `directory` is always absent on V2.                  | 2, 4 |

## Open items and caveats

- **Not probed on a running host (no model available):**
  - actually executing a tool call, so the V2 `execute` context is source-only;
  - `session.synthetic` / `prompt` delivery behavior (§3);
  - OpenTUI 0.8/0.9 rendering of this repo's components.
- V2 was run at **2.3.2** only. Re-run `$SPIKES/probe-q2.sh` equivalents against 2.3.0 and 2.3.1 when Unit 5 pins the host.
- V2 location behaviour was probed with `opencode serve`. The managed background service in default TUI mode was not run, but it uses the same `serve` code path (`packages/cli/src/server-process.ts`).
- The first `GET /api/plugin` on a fresh location returned `data: []` before activation had finished (a boot race). Use `awaitActivation`-style polling in any future host-contract test.
- Probe artifacts are throwaway and remain under `$SPIKES` (not in the repo). The code that matters is reproduced in the evidence sections above.
