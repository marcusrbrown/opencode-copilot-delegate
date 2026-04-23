# OpenCode Copilot Delegate Plugin — Implementation Plan

**Date:** 2026-04-21
**Status:** Plan ready for review (Metis pass 1 incorporated 2026-04-22)
**Predecessor:** `~/.context/systematic/ce-brainstorm/2026-04-21-copilot-delegate-plugin-requirements.md`
**Predecessor (ideation):** `~/.context/systematic/ce-ideation/2026-04-21-copilot-cli-delegation.md`

## Mental Model (Corrected)

The parent OpenCode agent is **not** single-threaded. It can call other tools, spawn subagents via the native `task` tool, perform direct work, and continue interacting with the user while a delegated Copilot subprocess runs. The plugin's job is:

1. Spawn `copilot -p ... --output-format json` in the background.
2. Return a `task_id` synchronously so the parent agent never blocks.
3. When the subprocess completes, **push a `<system-reminder>` notification into the parent session** so the parent agent gets a turn and knows results are ready.
4. Provide a separate tool to retrieve the structured envelope on demand.

This is exactly the pattern OMO (`oh-my-openagent`) uses internally for its `background_task` / `background_output` tools, and it's the pattern `opencode-pty` uses publicly for PTY notifications.

## Verified Evidence (from research, 2026-04-21)

### Plugin API surface

`PluginInput` exposes (verified at `~/.local/share/mise/installs/npm-cortexkit-aft-opencode/0.14.0/node_modules/@opencode-ai/plugin/dist/index.d.ts`):

- `client: ReturnType<typeof createOpencodeClient>` — full SDK client.
- `directory: string` — working directory.
- `worktree: string` — git worktree path.
- `project: Project` — project metadata.
- `serverUrl: URL` — plugin server URL.
- `$: BunShell` — shell execution helper.
- `experimental_workspace.register(type, adaptor)` — workspace adaptor registration.

### Async notification injection (the key mechanism)

OMO uses (verified at `~/.cache/opencode/packages/oh-my-openagent@3.17.4/node_modules/oh-my-openagent/dist/index.js` line `62018`, plus additional callsites at `64261` and `66174`; types verified at `@opencode-ai/sdk/dist/gen/types.gen.d.ts` lines `2241` and `2326` — both `SessionPromptData` and `SessionPromptAsyncData` accept `noReply?: boolean`):

```typescript
await client.session.promptAsync({
  path: { id: task.parentSessionID },
  body: {
    noReply: !allComplete,             // true while other tasks still running; false when last completes
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(resolvedTools ? { tools: resolvedTools } : {}),
    parts: [createInternalAgentTextPart(notification)],
  },
});
```

**`noReply` semantics (verified):**

- `noReply: true` → message is injected into the parent session but does NOT force the parent agent to take a turn. The next time the parent agent runs (e.g., when another task completes with `noReply: false`, or when the user types), the reminder is visible in context.
- `noReply: false` → forces the parent to take a turn now. OMO uses this only when ALL in-flight tasks have completed (so the parent gets exactly one wake-up regardless of how many tasks finished in the same window).

The notification text itself is built as a `<system-reminder>` block. `createInternalAgentTextPart()` (verified at `~/.cache/opencode/packages/oh-my-openagent@3.17.4/node_modules/oh-my-openagent/dist/index.js` near line `62713`) wraps the text and appends `OMO_INTERNAL_INITIATOR_MARKER` so the runtime can identify the part as system-injected:

```
<system-reminder>
[BACKGROUND TASK COMPLETED]
**ID:** `<task_id>`
**Description:** <description>
**Duration:** <duration>

**N tasks still in progress.** You WILL be notified when ALL complete.
Do NOT poll - continue productive work.

Use `background_output(task_id="<task_id>")` to retrieve this result when ready.
</system-reminder>
```

OMO detects completion via two paths: polling `client.session.status()` every 2s (`POLL_INTERVAL_BACKGROUND_MS = 2000`) and reacting to `session.idle` events from `client.event.subscribe()`. Our plugin doesn't have parent OpenCode sessions to watch — it has Copilot subprocesses. We detect completion via the subprocess `close` event directly, then call `client.session.promptAsync()` with the parent session ID.

### Tool registration

Verified at `~/src/github.com/marcusrbrown/systematic/`:

```typescript
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

export const CopilotDelegate: Plugin = async ({ client, directory }) => ({
  tool: {
    copilot_delegate: tool({
      description: '...',                           // string or getter
      args: { prompt: tool.schema.string().describe('...') },
      async execute(args, ctx) {
        // ctx.sessionID, ctx.ask({...}), ctx.metadata({...})
        return { task_id }
      },
    }),
  },
})
```

`ctx.sessionID` is the parent session ID — exactly what we pass to `client.session.promptAsync({ path: { id: ctx.sessionID } })` for completion injection.

### Reference implementation: `opencode-pty`

`shekohex/opencode-pty` uses the same pattern publicly:

```typescript
await client.session.prompt({
  path: { id: input.sessionID },
  body: {
    noReply: true,
    parts: [{ type: 'text', text: message }],
  },
})
```

### Subprocess wrapping pattern

Reference implementation: `cloveric/cc-telegram-bridge` (`src/codex/process-adapter.ts`). Confirmed pattern:

- `spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell, env, cwd, windowsHide: true })`
- Line-buffer `stdout` and parse JSONL events incrementally (`stdoutLineBuffer.split(/\r?\n/)`).
- Maintain a `turnState` accumulator that updates from each parsed JSON line (extract `thread_id`, agent messages, `usage`, errors).
- On `close` event, resolve the promise with `{ state, stderrTail, exitCode }`.
- Honor `AbortSignal` → `killProcessTree(child.pid)` for cancellation.

### Copilot CLI invocation contract

Already documented in `~/.agents/skills/copilot-cli/SKILL.md`. The plugin always invokes:

```
copilot -p "<prompt>" --output-format json -s --allow-all-tools --no-ask-user [extras]
```

With optional `--agent`, `--model`, `--add-dir`, `--allow-tool`, `--deny-tool` extras passed through from tool args.

Auth precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > `~/.copilot/auth`. Plugin does NOT sanitize — out of scope for v1 (per brainstorm non-goals).

## Scope (v1)

### In scope

- Three registered tools: `copilot_delegate`, `copilot_output`, `copilot_cancel`.
- Async lifecycle with `<system-reminder>` injection on completion via `client.session.promptAsync`.
- Agent discovery in `copilot_delegate` description (built-in + `~/.copilot/agents/*.md` + `<cwd>/.github/agents/*.md`), refreshed on plugin load.
- JSONL event parsing into a structured envelope (`status`, `exit_code`, `model`, `duration_ms`, `tokens`, `final_message`, `tool_calls_summary`, `error?`).
- Cancellation via SIGTERM with SIGKILL escalation after grace period.
- Standalone npm package + GitHub repo with semver and changelog.
- Skill update at `~/.agents/skills/copilot-cli/SKILL.md` to branch on plugin presence.

### Out of scope (deferred)

- Persona file system (Copilot owns `~/.copilot/agents/`).
- Transcript/`--share` artifact handling.
- `ce:compound` integration.
- Auth shim (sanitizing `GH_TOKEN`, etc.).
- MCP-over-Copilot or trajectory capture.
- Streaming returns from `execute` (unverified runtime capability).
- Dynamic SKILL.md rewriting from the plugin.

## Tool I/O Contracts

### `copilot_delegate`

**Args (validated via `tool.schema`):**

```typescript
{
  prompt: string                      // required, min length 1
  agent?: string                      // optional; must match a discovered agent name or be 'default'
  model?: string                      // optional; passed through to --model
  add_dir?: string[]                  // optional; each becomes --add-dir <path>
  allow_tool?: string[]               // optional; each becomes --allow-tool <pattern>
  deny_tool?: string[]                // optional; each becomes --deny-tool <pattern>
}
```

**Returns:**

```typescript
{ task_id: string }                   // 'cpl_' + uuid v4
```

**Errors:** Throws if `copilot` binary not on PATH (clear message with install hint). Logs (not throws) on unknown agent name and falls through to default.

### `copilot_output`

**Args:**

```typescript
{
  task_id: string                     // required, must start with 'cpl_'
  block?: boolean                     // default false
  timeout_ms?: number                 // default 30000, max 120000
}
```

**Returns (envelope):**

```typescript
{
  task_id: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  exit_code?: number                  // present when status !== 'running'
  agent?: string                      // resolved agent name or undefined for default
  model?: string                      // resolved model name or undefined for default
  duration_ms: number                 // wall clock so far (or final)
  tokens?: { input: number; output: number; total: number }  // best-effort from JSONL usage events
  final_message?: string              // ANSI-stripped last assistant message; undefined while running
  tool_calls_summary: { name: string; count: number }[]      // aggregated from tool_use events
  error?: string                      // stderr tail (last 4KB) when status === 'failed'
  timed_out?: boolean                 // true when block: true and timeout_ms elapsed before close
  events_count: number                // diagnostic: how many JSONL lines were parsed
}
```

**Errors:** Returns `{ task_id, status: 'unknown', error: 'task_id not found in this OpenCode process' }` when registry miss. Does NOT throw \u2014 lets the agent continue.

### `copilot_cancel`

**Args:**

```typescript
{ task_id: string }                   // required
```

**Returns:**

```typescript
{ cancelled: boolean; was_running: boolean }
```

`cancelled: true, was_running: true` is the success case. `cancelled: false, was_running: false` if already terminated. Does NOT throw on unknown `task_id`; returns `{ cancelled: false, was_running: false }`.

### Module layout

```
opencode-copilot-delegate/
├── src/
│   ├── index.ts                # Plugin entrypoint; registers three tools
│   ├── tools/
│   │   ├── delegate.ts         # copilot_delegate
│   │   ├── output.ts           # copilot_output
│   │   └── cancel.ts           # copilot_cancel
│   ├── runtime/
│   │   ├── task-registry.ts    # In-memory map: task_id → TaskState
│   │   ├── subprocess.ts       # spawn + line-buffered stdout parsing
│   │   ├── jsonl-parser.ts     # JSONL event → turn state accumulator
│   │   ├── notify.ts           # client.session.promptAsync wrapper
│   │   └── envelope.ts         # turn state → structured envelope
│   ├── discovery/
│   │   ├── agents.ts           # Built-in + user + repo agent merge
│   │   └── description.ts      # Build copilot_delegate description string
│   └── lib/
│       ├── ansi.ts             # Strip ANSI escapes
│       └── kill-tree.ts        # killProcessTree helper
├── tests/
│   ├── jsonl-parser.test.ts
│   ├── envelope.test.ts
│   ├── agents.test.ts
│   └── subprocess.test.ts
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
└── LICENSE
```

### TaskState shape

```typescript
type TaskState = {
  taskId: string
  parentSessionID: string         // captured from ctx.sessionID at delegate time
  pid: number
  startedAt: number               // Date.now()
  endedAt?: number
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  exitCode?: number
  args: string[]                  // resolved CLI args (for debugging)
  cwd: string
  agentName?: string
  modelName?: string
  stdoutLineBuffer: string        // partial line from line-splitting
  events: ParsedEvent[]           // accumulated JSONL events
  finalMessage?: string
  errorText?: string
  child: ChildProcess             // node:child_process handle
  abortController: AbortController
}
```

Stored in a single in-memory `Map<string, TaskState>` (`taskRegistry`) at plugin scope. Keyed by `task_id` (UUID v4 prefixed `cpl_`). Cleaned up on plugin shutdown via `Bun.signal` / process exit.

### Event flow (single delegation)

1. Parent agent calls `copilot_delegate({ prompt, agent?, model?, ... })`.
2. Tool builds CLI args, calls `spawn('copilot', args, ...)`, captures `child.pid`.
3. Tool builds `TaskState`, registers under `task_id`, attaches stdout line-buffer parser.
4. Tool returns `{ task_id }` synchronously.
5. Parent agent does other work.
6. Subprocess emits JSONL lines on stdout → parser extracts thread_id, agent messages, usage, errors → updates `state.events`.
7. Subprocess `close` event fires → tool computes `endedAt`, sets `status` from exit code, builds completion notification, calls `client.session.promptAsync({ path: { id: parentSessionID }, body: { noReply: false, parts: [createInternalTextPart(notification)] } })`.
8. Parent agent receives a turn with the `<system-reminder>` content visible.
9. Parent agent calls `copilot_output(task_id)`.
10. Tool reads `TaskState` from registry, builds envelope from accumulated events, returns it.

### Cancellation flow

1. Parent agent calls `copilot_cancel({ task_id })`.
2. Tool looks up `TaskState`, calls `killProcessTree(state.pid, 'SIGTERM')`.
3. After 2s grace period, escalates to SIGKILL if still alive.
4. Sets `state.status = 'cancelled'`, fires the same completion notification path as natural exit.
5. Returns `{ cancelled: true }`.

### `notification` message shape

Mirroring OMO's format so the parent agent gets a familiar pattern:

```
<system-reminder>
[COPILOT DELEGATION COMPLETED]
**Task ID:** `<task_id>`
**Agent:** <agent or "default">
**Model:** <model or "default">
**Duration:** <human-readable duration>
**Status:** <complete | failed | cancelled>

Use `copilot_output(task_id="<task_id>")` to retrieve the structured result.
</system-reminder>
```

When `status = failed`, append `**ACTION REQUIRED:** Subprocess exited with code <N>. Check copilot_output for error details.` and set `noReply: false` (force a turn). When `status = complete` and only one task is in flight, set `noReply: false` so the parent gets a turn. When multiple delegations are running and only one finishes, OMO's pattern is `noReply: true` until all complete; we mirror that by tracking a per-parent-session count of in-flight tasks.

### Description string for `copilot_delegate`

Built once at plugin load by `discovery/description.ts`. Pseudocode:

```typescript
function buildDescription(directory: string): string {
  const builtIn: AgentInfo[] = [
    { name: 'default', source: 'builtin', summary: 'Copilot picks the best path' },
    // (Verify Copilot's actual built-in agent names at implementation time —
    // brainstorm doc lists "Explore", "Task", "General-purpose", "Code-review"
    // but we'll cross-check against `copilot agent list` or docs.)
  ]
  const userAgents = scanAgentDir(`${homedir()}/.copilot/agents`)
  const repoAgents = scanAgentDir(`${directory}/.github/agents`)
  const merged = mergeAgents(builtIn, userAgents, repoAgents) // user/repo override builtin

  return [
    'Delegate a task to GitHub Copilot CLI as a background subprocess.',
    'Returns a task_id immediately; parent agent continues other work.',
    'When Copilot completes, a system-reminder is injected into this session.',
    'Retrieve the structured result with `copilot_output(task_id)`.',
    '',
    'Available Copilot agents (pass via `agent` arg, or omit for default):',
    ...merged.map(a => `  - ${a.name} (${a.source})${a.summary ? ` — ${a.summary}` : ''}`),
  ].join('\n')
}
```

Refresh cadence: plugin load only (= OpenCode restart). Re-scanning per call adds I/O on the hot path with no clear benefit.

## Tasks (ordered)

### T1. Repo bootstrap

- Create `opencode-copilot-delegate` GitHub repo at `marcusrbrown/opencode-copilot-delegate`. Local clone at `~/src/github.com/marcusrbrown/opencode-copilot-delegate`.
- `package.json`: name `opencode-copilot-delegate` (unscoped public package), `version: "0.1.0"`, `type: "module"`, `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"]`, `engines.node: ">=20"`, `peerDependencies`: `@opencode-ai/plugin`, `@opencode-ai/sdk`. Stay on `0.x` during initial development.
- `repository.url`, `bugs.url`, `homepage` all point to `github.com/marcusrbrown/opencode-copilot-delegate`. `keywords: ["opencode", "opencode-plugin", "copilot", "github-copilot", "agent", "delegation"]` for npm discoverability.
- `tsconfig.json`: target ES2022, module ESNext, strict.
- `bun` as build runner; ship pre-built `dist/index.js` + `dist/index.d.ts`.
- Test runner: `bun test` (matches OpenCode ecosystem).
- License: MIT.
- `.changeset/` for changelog (matches Marcus's `.dotfiles` workflow with Renovate/Changesets).

**QA scenarios:**
1. `gh repo view marcusrbrown/opencode-copilot-delegate --json name,visibility,defaultBranchRef` → returns `name: "opencode-copilot-delegate"`, `visibility: "PUBLIC"`, `defaultBranchRef.name: "main"`.
2. From repo root: `bun install && bun pm ls` → exits `0`, lists `@opencode-ai/plugin` and `@opencode-ai/sdk` under peerDependencies.
3. `cat package.json | jq '.name, .version, .type, .main, .types, .engines.node'` → returns `"opencode-copilot-delegate"`, `"0.1.0"`, `"module"`, `"dist/index.js"`, `"dist/index.d.ts"`, `">=20"`.
4. `ls .changeset/config.json LICENSE tsconfig.json` → all three files exist.
5. `bun run build` → exits `0`, produces `dist/index.js` and `dist/index.d.ts`.

### T2. JSONL parser + envelope builder

- `runtime/jsonl-parser.ts`: line buffer + `JSON.parse` per line, defensive (skip malformed lines, log via `client.app.log`).
- Output type: `ParsedEvent = { type: 'message' | 'tool_use' | 'tool_result' | 'usage' | 'error' | 'unknown', ...payload }`.
- `runtime/envelope.ts`: fold events into the `copilot_output` envelope shape from the brainstorm doc.
- Tests: feed canned JSONL fixtures (capture real Copilot output once during T2 dev) → assert envelope shape; degrade gracefully on missing fields.
- Reference: `devopspass/devopspass` `agent_events.py` parsing patterns (already in memory).

**QA scenarios:**
1. `bun test tests/jsonl-parser.test.ts` → exits `0`; suite includes `parses happy-path fixture`, `skips malformed lines`, `extracts thread_id from first event`, `accumulates usage tokens across events`.
2. `bun test tests/envelope.test.ts` → exits `0`; suite includes `builds envelope from happy-path events`, `returns status: 'failed' with stderr tail when error event present`, `aggregates tool_use events into tool_calls_summary`, `degrades gracefully when usage event missing`.
3. From repo root: `bun -e "import {parseJsonlLine} from './src/runtime/jsonl-parser.ts'; console.log(parseJsonlLine('not-json').type)"` → prints `unknown` (does not throw).
4. `bun -e "import {buildEnvelope} from './src/runtime/envelope.ts'; const env = buildEnvelope({events: [], status: 'running', startedAt: Date.now()}); console.log(JSON.stringify(Object.keys(env).sort()))"` → output includes `task_id`, `status`, `duration_ms`, `events_count`, `tool_calls_summary`.

### T2.5. JSONL fixture capture (one-time, blocks T2 tests)

- Run `copilot -p "Read README.md and summarize in 2 sentences" --output-format json -s --allow-all-tools --no-ask-user --model claude-haiku-4.5 > tests/fixtures/happy-path.jsonl` (use a path inside the plugin repo so Copilot's default cwd allowlist accepts it) against the live Copilot CLI.
- Capture 3 fixtures total: happy path, model-not-found error, and a multi-tool-call session (e.g., explore agent reading multiple files).
- Strip any session-specific identifiers (paths under `/Users/mrbrown/`, etc.) before committing. Document fixture provenance and Copilot CLI version (`copilot --version`) in `tests/fixtures/README.md`.
- These fixtures pin the JSONL schema for v0.1.0; any failing test on a future Copilot CLI version is a signal to refresh fixtures and bump the plugin minor.

**QA scenarios:**
1. `ls tests/fixtures/happy-path.jsonl tests/fixtures/model-error.jsonl tests/fixtures/multi-tool.jsonl tests/fixtures/README.md` → all four files exist.
2. `wc -l tests/fixtures/*.jsonl | tail -1` → total non-zero (each fixture has at least one event).
3. `head -1 tests/fixtures/happy-path.jsonl | jq 'has("type")'` → returns `true` (each line is valid JSON with a `type` field).
4. `grep -RnE '/Users/[a-z]+/' tests/fixtures/` → no matches (PII scrubbed).
5. `grep -F 'copilot --version' tests/fixtures/README.md` → matches (provenance documented).



### T3. Subprocess wrapper + registry

- `runtime/subprocess.ts`: `spawn` with explicit env (preserve auth precedence), `cwd = directory`, line-buffered stdout pipe.
- `lib/kill-tree.ts`: cross-platform process tree kill (Bun's `process.kill` + tree-kill fallback for child PIDs).
- `lib/ansi.ts`: strip ANSI before storing `finalMessage`.
- Tests: spawn `bash -c 'echo {"type":"message","text":"hi"}'`-style fixtures; verify `close` triggers state transition.

**QA scenarios:**
1. `bun test tests/subprocess.test.ts` → exits `0`; suite includes `spawn → close transitions status to 'complete' on exit 0`, `spawn → close transitions status to 'failed' on non-zero exit`, `line-buffer accumulates partial JSONL across chunk boundaries`, `kill-tree terminates child + grandchild process`.
2. `bun test tests/subprocess.test.ts -t 'kill-tree'` → exits `0` (cross-platform process tree kill verified).
3. From repo root in a Bun REPL: spawn `sleep 30`, capture `pid`, call `killProcessTree(pid, 'SIGTERM')`, then `kill -0 <pid>` from another shell → returns non-zero (process dead) within 3 seconds.
4. `bun -e "import {stripAnsi} from './src/lib/ansi.ts'; console.log(stripAnsi('\\x1b[31mred\\x1b[0m'))"` → prints `red` (no escape sequences).

### T4. Notification injection

- `runtime/notify.ts`: wrapper around `client.session.promptAsync` with the `<system-reminder>` template.
- Track per-parent-session in-flight task count to set `noReply` correctly (mirror OMO behavior: false when all complete, true when others still running).
- Test manually first: spawn one Copilot delegation in a real OpenCode session, confirm the notification appears as a `<system-reminder>` user-message-like turn.

**QA scenarios:**
1. In a real OpenCode session with the plugin loaded: invoke `copilot_delegate({prompt: 'echo PONG', model: 'claude-haiku-4.5'})` → `task_id` returned synchronously within 500ms; subsequent assistant turn shows the `<system-reminder>` block with `[COPILOT DELEGATION COMPLETED]` heading.
2. `bun test tests/notify.test.ts -t 'in-flight counter'` → exits `0`; verifies that with 3 simulated tasks, completing #1 and #2 calls `promptAsync` with `noReply: true` and #3 with `noReply: false`.
3. `bun test tests/notify.test.ts -t 'failed status forces turn'` → exits `0`; verifies that `status: 'failed'` always sets `noReply: false` regardless of in-flight count.
4. Inspect `client.session.promptAsync` call args via a stubbed client in `tests/notify.test.ts` → asserts `body.noReply` boolean is set explicitly (never `undefined`) and `body.parts[0].text` contains `<system-reminder>` and `[COPILOT DELEGATION COMPLETED]` literals.

### T5. Agent discovery + description

- `discovery/agents.ts`: scan `~/.copilot/agents/*.md` and `<directory>/.github/agents/*.md`, parse frontmatter + first paragraph for summary.
- `discovery/description.ts`: merge built-in (verified list at impl time) + user + repo, render as multi-line description string.
- Tests: fixture directories with known agent files → assert merged ordering and override behavior.

**QA scenarios:**
1. `bun test tests/agents.test.ts` → exits `0`; suite includes `built-in agents listed first`, `user agents from ~/.copilot/agents merged after built-in`, `repo agents from .github/agents/ merged after user`, `repo agent overrides user agent with same name`, `missing agent dir returns empty list (no throw)`.
2. `bun -e "import {scanAgentDir} from './src/discovery/agents.ts'; console.log((await scanAgentDir('tests/fixtures/agents/user')).map(a => a.name).sort().join(','))"` → prints comma-separated list matching the fixture filenames (sans `.md`).
3. `bun -e "import {buildDescription} from './src/discovery/description.ts'; console.log(buildDescription('tests/fixtures/repo-with-agents'))"` → output contains `Available Copilot agents`, lists `default (builtin)` first, and includes at least one `(user)` and one `(repo)` agent line.
4. `bun -e "import {buildDescription} from './src/discovery/description.ts'; const d = buildDescription('/nonexistent'); console.log(d.includes('default (builtin)'))"` → prints `true` (degrades gracefully when no user/repo agents found).

### T6. Tool wiring

- `tools/delegate.ts`: build args, call subprocess wrapper, register `TaskState`, return `task_id`.
- `tools/output.ts`: read state, build envelope, return. Args: `task_id: string` (required), `block?: boolean` (default `false`), `timeout_ms?: number` (default `30000`, max `120000`). When `block: true`, await subprocess `close` event up to `timeout_ms`; on timeout return current state with `status: 'running'` and a `timed_out: true` flag. When `block: false` (default), return immediately regardless of subprocess status.
- `tools/cancel.ts`: cancel + return.
- `index.ts`: export `Plugin` that registers all three tools and wires `client` into the runtime.

**QA scenarios:**
1. `bun run build && bun -e "import plugin from './dist/index.js'; const stub = {client: {}, directory: process.cwd(), worktree: process.cwd(), project: {}, serverUrl: new URL('http://localhost'), \$: {}}; const result = await plugin(stub); console.log(Object.keys(result.tool).sort().join(','))"` → prints `copilot_cancel,copilot_delegate,copilot_output`.
2. `bun -e "import plugin from './dist/index.js'; const stub = {client: {}, directory: process.cwd(), worktree: process.cwd(), project: {}, serverUrl: new URL('http://localhost'), \$: {}}; const r = await plugin(stub); console.log(typeof r.tool.copilot_delegate.execute)"` → prints `function` (each registered tool has an `execute` function).
3. `bun test tests/tools.test.ts` → exits `0`; suite includes `copilot_delegate returns task_id matching /^cpl_[0-9a-f-]+$/`, `copilot_output returns status: 'unknown' for missing task_id (does not throw)`, `copilot_cancel returns {cancelled: false, was_running: false} for missing task_id`, `copilot_output with block:true honors timeout_ms`.
4. `bun -e "import plugin from './dist/index.js'; const stub = {client: {}, directory: process.cwd(), worktree: process.cwd(), project: {}, serverUrl: new URL('http://localhost'), \$: {}}; const r = await plugin(stub); console.log(r.tool.copilot_delegate.description.length > 50)"` → prints `true` (description string built and non-trivial).

### T7. End-to-end manual verification

Each scenario below MUST be exercised in a real OpenCode session with the plugin installed before tagging v0.1.0. Capture the result (✅/❌ + notes) in a `VERIFICATION.md` checked into the repo.

1. **Happy path:** `copilot_delegate({ prompt: 'Read README.md and summarize what this plugin does in 2 sentences.', model: 'claude-haiku-4.5' })` → returns `task_id` synchronously. (Use repo-internal path; do not hand Copilot a `$HOME`-rooted path unless `add_dirs` is also set.) Parent agent reads another file while subprocess runs. `<system-reminder>` arrives in session. `copilot_output(task_id)` returns envelope with non-empty `final_message`.
2. **Cancellation mid-flight:** Delegate a long-running prompt (e.g., agent that runs many tool calls). Call `copilot_cancel({ task_id })` after 5s. Verify SIGTERM → SIGKILL escalation works and subsequent `copilot_output` returns `status: 'cancelled'` with the partial transcript intact.
3. **Failed exit:** Delegate with `model: 'nonexistent-model-name'`. Verify `<system-reminder>` arrives with `Status: failed`, `noReply: false` forces a parent turn, and envelope contains the stderr tail in `error`.
4. **Concurrent delegations:** Fire 3 delegations back-to-back to different agents. Verify only the LAST completion sets `noReply: false`; the first two arrive silently as `noReply: true`. Verify per-parent-session in-flight counter decrements correctly even when one fails.
5. **`copilot_output` blocking mode:** Delegate a 10s task. Immediately call `copilot_output({ task_id, block: true, timeout_ms: 3000 })`. Verify `timed_out: true` returns; then call again without `block` and confirm final state once subprocess finishes naturally.
6. **Plugin reload mid-flight:** Delegate, then trigger an OpenCode plugin reload (or restart). Verify the orphaned subprocess is documented in README as a known v1 limitation (PID-file reaper deferred to v1.x).
7. **TUI toast:** Verify `client.tui.showToast(...)` fires on completion. Verify behavior when the session is focused vs background; if it double-fires with the session prompt, drop the toast (resolved decision #4 caveat).
8. **Description string accuracy:** With one fixture agent in `~/.copilot/agents/test-agent.md` and one in `<repo>/.github/agents/repo-agent.md`, restart OpenCode, inspect tool catalog — confirm both appear in `copilot_delegate` description with correct `(user)` / `(repo)` source labels and built-in agents are listed first.

### T8. Skill update (REQUIRED, not optional)

This is part of the v0.1.0 release, not a follow-up. Without it, agents won't know to prefer the plugin tools over the raw subprocess pattern.

Edit `~/.agents/skills/copilot-cli/SKILL.md` to add the runtime branch at the top:

> **If your tool catalog includes `copilot_delegate`, `copilot_output`, and `copilot_cancel`** (provided by the `opencode-copilot-delegate` plugin), prefer those tools for delegation. They handle subprocess lifecycle, JSONL parsing, structured returns, and async completion notifications for you. See [plugin README](https://github.com/...) for tool args.
>
> **Otherwise**, use the direct subprocess pattern below.

Existing manual subprocess content stays unchanged beneath the branch. Commit through the dotfiles bare-repo workflow.

**QA scenarios:**
1. `GIT_DIR=$HOME/.dotfiles GIT_WORK_TREE=$HOME git diff -- .agents/skills/copilot-cli/SKILL.md` → shows the new "If your tool catalog includes..." branch added at the top, original subprocess content unchanged below.
2. `head -20 ~/.agents/skills/copilot-cli/SKILL.md | grep -F 'copilot_delegate'` → matches (branch present in first 20 lines).
3. In a fresh OpenCode session with the plugin installed: invoke the skill and confirm the agent picks the plugin branch by referencing `copilot_delegate` instead of constructing a raw `copilot -p ...` command.

### T9. Publish

- `bun run build` → `dist/`.
- `npm publish --access=public` (or scoped equivalent).
- Tag `v0.1.0`, push to GitHub, generate release notes from `.changeset/`.
- Add the package to Marcus's installed plugins via OpenCode config (`~/.config/opencode/opencode.json` `plugin: ["opencode-copilot-delegate"]` or equivalent).

**QA scenarios:**
1. `npm view opencode-copilot-delegate version` → returns `0.1.0`.
2. `npm view opencode-copilot-delegate dist.tarball` → returns a non-empty `https://registry.npmjs.org/...` URL.
3. `gh release view v0.1.0 --repo marcusrbrown/opencode-copilot-delegate --json tagName,isLatest` → returns `tagName: "v0.1.0"`, `isLatest: true`.
4. Restart OpenCode; in a fresh session, run `/help` or inspect the tool catalog → `copilot_delegate`, `copilot_output`, `copilot_cancel` are listed.
5. `jq '.plugin' ~/.config/opencode/opencode.json` → array contains `"opencode-copilot-delegate"` (or pinned version spec).

### T10. File dotfiles PR for skill update (REQUIRED)

This ships with v0.1.0. Sequence: publish plugin → file PR with skill update referencing the published version.

- Branch `skills/copilot-cli-plugin-branch` off `main`.
- Single commit: `feat(skills): branch copilot-cli skill on plugin presence`.
- PR body links to plugin repo + plugin v0.1.0 release notes + this plan.

**QA scenarios:**
1. `gh pr view <pr-number> --repo marcusrbrown/.dotfiles --json state,headRefName,mergeable` → `state: "OPEN"`, `headRefName: "skills/copilot-cli-plugin-branch"`, `mergeable: "MERGEABLE"`.
2. `gh pr view <pr-number> --repo marcusrbrown/.dotfiles --json files | jq '.files[].path'` → lists exactly `.agents/skills/copilot-cli/SKILL.md` (single-file PR).
3. `gh pr checks <pr-number> --repo marcusrbrown/.dotfiles` → all four required checks (`Devcontainer CI`, `Fro Bot`, `Install mise`, `Renovate`) report `pass`.
4. PR body contains links to: (a) `github.com/marcusrbrown/opencode-copilot-delegate`, (b) the v0.1.0 release notes, (c) this plan.

### T11. CI / quality gates (REQUIRED for v0.1.0)

- GitHub Actions workflow `.github/workflows/ci.yml`: install Bun, `bun install`, `bun test`, `bun run typecheck` (`tsc --noEmit`), `bun run lint` (Biome or oxlint).
- Branch protection on `main` requires `ci` to pass.
- `.changeset/` config: changesets bot enabled; PRs without a changeset for `src/**` changes fail CI.
- Pre-commit: optional husky hook running `bun run typecheck` on staged TS files.

**QA scenarios:**
1. `gh workflow list --repo marcusrbrown/opencode-copilot-delegate` → includes `ci`.
2. Push a trivial commit on a throwaway branch → `gh run list --workflow=ci.yml --branch=<branch> --limit 1 --json conclusion` returns `conclusion: "success"`.
3. `gh api repos/marcusrbrown/opencode-copilot-delegate/branches/main/protection --jq '.required_status_checks.contexts'` → array contains `"ci"`.
4. Open a no-op PR touching `src/foo.ts` without a changeset → `gh pr checks <pr-number>` shows the changeset gate failing; add a changeset, re-run → it passes.
5. From repo root: `bun install && bun test && bun run typecheck && bun run lint` → all four exit `0`.

## Telemetry / Privacy posture

The plugin collects ZERO telemetry. It does NOT phone home, does NOT track usage, does NOT log to remote services. All logging goes through `client.app.log(...)` which OpenCode handles locally per its own settings. The plugin never logs the resolved auth token value \u2014 only the auth source name (`COPILOT_GITHUB_TOKEN | GH_TOKEN | GITHUB_TOKEN | ~/.copilot/auth`) at delegate start. Document this explicitly in README under a `Privacy` heading.

## Open questions (deferred, not blockers for v0.1.0)

- Does `client.tui.showToast(...)` exist in the current OpenCode SDK, and what's its exact signature? Verify at impl time during T4. If absent, drop resolved decision #4 and document in README.
- Built-in Copilot agent names: brainstorm doc lists `Explore`, `Task`, `General-purpose`, `Code-review`. Verify at impl time \u2014 some Copilot docs use different casing. Hardcoded list is in `discovery/agents.ts`.
- `noReply: true` behavior with the OpenCode TUI: does an injected message visibly appear in the conversation history, or is it silent until the parent's next turn? Test during T7.



| Risk | Mitigation |
| --- | --- |
| OpenCode plugin runtime crashes mid-delegation → orphaned `copilot` subprocess. | Document in README. v1.x: write PID file under `${XDG_RUNTIME_DIR}/opencode-copilot-delegate/<task_id>.pid`; plugin start scans for stale PIDs and reaps. |
| Copilot CLI changes JSONL schema. | Defensive parsing (every field optional, unknown event types stored verbatim). Snapshot a real JSONL fixture at v0.1.0 to detect drift via tests. |
| `noReply` semantics differ between `prompt` and `promptAsync` in current SDK. | Verify against `OpencodeClient` types at impl time; if `promptAsync` doesn't accept `noReply`, fall back to `prompt` (used by `opencode-pty` reference). |
| Description string bloats with many user agents. | Cap merged list at 20; if more, show first 20 + `... and N more (use copilot_list_agents to see all)` and ship `copilot_list_agents` in v1.x. |
| Auth misconfiguration (stale `GH_TOKEN` overrides login) → silent failures. | Plugin logs the resolved auth source via `client.app.log` at delegate start (without leaking the token). |
| Built-in Copilot agent names guessed wrong. | At impl time, run `copilot agent list` (or scan docs) to confirm. Hardcoded list lives in one place (`discovery/agents.ts`) for easy update. |
| `kill-tree` flakiness on macOS vs Linux. | Use `tree-kill` npm package (battle-tested) instead of rolling our own. |

## Resolved decisions

1. **Repo/package name:** `opencode-copilot-delegate`. Local clone at `~/src/github.com/marcusrbrown/opencode-copilot-delegate`. Public unscoped npm package with the same name.
2. **Versioning:** Start at `0.1.0` and stay on `0.x` during initial development (unstable).
3. **`TaskState` lifecycle:** Keep until plugin shutdown so repeat `copilot_output` calls are idempotent. No `discard` arg in v1.
4. **TUI toast on completion:** Yes. Call `client.tui.showToast(...)` alongside the session-prompt injection. Verify against the SDK at impl time that it doesn't double-fire when the session is already focused.
5. **Cross-session task visibility:** Single-session scope. `TaskState` is in-memory inside one OpenCode process; `copilot_output` from a different OpenCode process returns a clean `task_id not found in this OpenCode process` error. Document the boundary in the README. Defer cross-process sharing (sqlite registry + IPC + notification fanout) to a future major version if demand emerges.

## Success criteria (carry-over from brainstorm)

1. Parent agent calls `copilot_delegate` with prompt + agent name, receives `task_id`, does other work, then receives a `<system-reminder>` injection when Copilot finishes, then calls `copilot_output(task_id)` to retrieve the envelope.
2. `copilot_delegate` tool description lists merged built-in + user + repo Copilot agents in a fresh session, verifiable via the OpenCode tool catalog inspector.
3. `copilot_cancel` cleanly terminates a long-running delegation; subsequent `copilot_output` returns `status: cancelled`.
4. With plugin installed, the `copilot-cli` skill points to the plugin tools. Without it, the skill falls back to the manual subprocess pattern.
5. Plugin published as a standalone npm package with its own GitHub repo, semver, and `.changeset/`-managed changelog.

## References

- Brainstorm: `~/.context/systematic/ce-brainstorm/2026-04-21-copilot-delegate-plugin-requirements.md`
- Ideation: `~/.context/systematic/ce-ideation/2026-04-21-copilot-cli-delegation.md`
- Existing skill: `~/.agents/skills/copilot-cli/SKILL.md`
- OMO async notification source (verified against installed `oh-my-openagent@3.17.4`): `~/.cache/opencode/packages/oh-my-openagent@3.17.4/node_modules/oh-my-openagent/dist/index.js` line `62018` (primary `client.session.promptAsync` injection with `noReply: !allComplete`); additional callsites at `64261` and `66174`; `OMO_INTERNAL_INITIATOR_MARKER` constant + `createInternalAgentTextPart` near line `62713`; visibility filter at line `147627`tTextPart` wraps text and appends `OMO_INTERNAL_INITIATOR_MARKER`).
- OpenCode SDK type confirmation: `@opencode-ai/sdk/dist/gen/types.gen.d.ts` lines `2241` (`SessionPromptData.body.noReply`) and `2326` (`SessionPromptAsyncData.body.noReply`) \u2014 both endpoints accept `noReply?: boolean`.
- Public reference for `client.session.prompt` injection: `shekohex/opencode-pty` `src/plugin.ts`.
- Subprocess wrapping reference: `cloveric/cc-telegram-bridge` `src/codex/process-adapter.ts`.
- Plugin tool API reference: `~/src/github.com/marcusrbrown/systematic/`.
- OpenCode plugin types: `~/.local/share/mise/installs/npm-cortexkit-aft-opencode/0.14.0/node_modules/@opencode-ai/plugin/dist/index.d.ts`.
- Copilot CLI custom agents docs: <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-agents/invoke-custom-agents>.
- Copilot CLI delegation patterns docs: <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-agents/delegate-tasks-to-cca>.
