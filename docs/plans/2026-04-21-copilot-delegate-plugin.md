---
title: "feat: OpenCode Copilot Delegate Plugin"
type: feat
status: active
date: 2026-04-21
origin: "~/.context/systematic/ce-brainstorm/2026-04-21-copilot-delegate-plugin-requirements.md"
deepened: 2026-04-23
second_deepening: 2026-04-23
confidence_checked: 2026-04-23
testing_strategy_updated: 2026-04-23
fro_bot_review_integrated: 2026-04-23
---

# feat: OpenCode Copilot Delegate Plugin

## Overview

An OpenCode plugin that lets the parent agent delegate work to the GitHub Copilot CLI (`copilot`) as a non-blocking background subprocess. The parent gets a `task_id` synchronously, does other work, and receives a `<system-reminder>` injection when Copilot finishes. A second tool retrieves the structured result; a third cancels an in-flight delegation.

The parent OpenCode agent is **not** single-threaded. It can call other tools, spawn subagents via the native `task` tool, perform direct work, and continue interacting with the user while a delegated Copilot subprocess runs. This is exactly the pattern OMO (`oh-my-openagent`) uses internally for its `background_task` / `background_output` tools, and the pattern `opencode-pty` uses publicly for PTY notifications.

## Problem Frame

Agents using OpenCode want to offload longer-running or Copilot-specific tasks to the GitHub Copilot CLI without blocking the parent session. There is no native mechanism to do this today — the CLI must be invoked as a subprocess, managed for output/cancellation, and results surfaced back into the active session asynchronously. This plugin provides that bridge as a standalone npm package.

## Requirements Trace

- R1. Parent agent calls `copilot_delegate`, receives `task_id` synchronously, does unrelated work while subprocess runs.
- R2. When Copilot finishes, a `<system-reminder>` is injected into the parent session; parent then calls `copilot_output(task_id)` to retrieve the structured envelope.
- R3. `copilot_delegate` description lists merged built-in + user + repo agents, refreshed at plugin load.
- R4. `copilot_cancel` cleanly terminates a running delegation; subsequent `copilot_output` returns `status: 'cancelled'`.
- R5. With plugin installed the `copilot-cli` skill branches to prefer plugin tools; without it, the skill falls back to the direct subprocess pattern.
- R6. Plugin published as a standalone npm package with semver and `.changeset`-managed changelog.

## Scope Boundaries

- No persona file system management (Copilot owns `~/.copilot/agents/`).
- No transcript/`--share` artifact handling.
- No auth shim (sanitizing `GH_TOKEN`, etc.) — out of scope for v1.
- No MCP-over-Copilot or trajectory capture.
- No streaming returns from `execute` — unverified runtime capability.
- No dynamic SKILL.md rewriting from the plugin.

### Deferred to Separate Tasks

- `ce:compound` integration: future iteration.
- Cross-process task sharing (sqlite registry + IPC + notification fanout): future major version.
- `copilot_list_agents` tool: v1.x, only needed if agent list exceeds 20 entries.
- PID-file reaper for orphaned subprocesses: v1.x.

## Context & Research

### Async Notification Mechanism

Verified against `oh-my-openagent@3.17.4`. OMO injects notifications via `client.session.promptAsync`:

```typescript
await client.session.promptAsync({
  path: { id: task.parentSessionID },
  body: {
    noReply: !allComplete,
    parts: [{ type: 'text', text: notification, synthetic: true }],
  },
});
```

`noReply` semantics (verified):
- `noReply: true` → message injected but does NOT force a parent turn. Used when other tasks still in flight.
- `noReply: false` → forces parent to take a turn now. OMO uses this only when ALL in-flight tasks complete.

OMO detects completion via polling `client.session.status()` every 2s and reacting to `session.idle` events. Our plugin detects completion via the subprocess `close` event directly.

`synthetic: true` on a `TextPartInput` is the public SDK equivalent of OMO's internal `OMO_INTERNAL_INITIATOR_MARKER`. `createInternalAgentTextPart()` is an OMO-internal helper not present in `@opencode-ai/plugin` or `@opencode-ai/sdk`; do not reference it in plugin code.

### Plugin API Surface

`PluginInput` exposes (verified against `@opencode-ai/plugin` v1.14.21 — stable since v1.4.17):

- `client: ReturnType<typeof createOpencodeClient>` — full SDK client.
- `directory: string` — working directory.
- `worktree: string` — git worktree path.
- `project: Project` — project metadata.
- `serverUrl: URL` — plugin server URL.
- `$: BunShell` — shell execution helper.
- `experimental_workspace.register(type, adaptor)` — workspace adaptor registration.

### Tool Registration Pattern

Verified at `src/` in the `marcusrbrown/systematic` repo:

```typescript
import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

export const CopilotDelegate: Plugin = async ({ client, directory }) => ({
  tool: {
    copilot_delegate: tool({
      description: '...',
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

### Reference Implementations

- **`shekohex/opencode-pty`** (`src/plugin.ts`): uses `client.session.prompt` with `noReply: true` + text part — same pattern.
- **`cloveric/cc-telegram-bridge`** (`src/codex/process-adapter.ts`): subprocess wrapping with `spawn`, line-buffered JSONL stdout, `turnState` accumulator, `AbortSignal` → `killProcessTree`, `close` event → resolve.

### Subprocess Pattern

```
spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell, env, cwd, windowsHide: true })
```
- Line-buffer `stdout`, parse JSONL events incrementally.
- Maintain a `turnState` accumulator (extract `thread_id`, messages, `usage`, errors).
- On `close` event, resolve with `{ state, stderrTail, exitCode }`.
- Honor `AbortSignal` → `killProcessTree(child.pid)` for cancellation.

### Copilot CLI Invocation Contract

Already documented in the `copilot-cli` skill. Always invokes:

```
copilot -p "<prompt>" --output-format json -s --allow-all-tools --no-ask-user [extras]
```

Optional extras: `--agent`, `--model`, `--add-dir`, `--allow-tool`, `--deny-tool`.

Auth precedence: `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > `~/.copilot/auth`.

### Institutional Learnings

- OMO in-flight counter pattern: track per-parent-session task count; `noReply: false` only on last completion. **Correctness invariant:** decrement the counter synchronously as the very first operation in the completion handler — before any `await` — or two concurrent completions can both read the same value and both set `noReply: false`, causing duplicate forced parent turns.
- `fkill` npm package (v10.0.3, Jan 2026, actively maintained) preferred over `tree-kill` (unmaintained since 2019) for SIGTERM→SIGKILL escalation with timeout.
- JSONL schema is version-specific — snapshot real Copilot output as test fixtures to detect drift.

## Key Technical Decisions

- **Three tools only:** `copilot_delegate`, `copilot_output`, `copilot_cancel` cover the full lifecycle for v1.
- **In-memory registry:** `Map<string, TaskState>` at plugin scope. Keyed by `cpl_` + UUID v4. Cleaned on plugin shutdown. Cross-process sharing deferred to v1.x (see Resolved Decision #5).
- **`noReply` tracking:** Mirror OMO — per-parent-session in-flight counter. First N-1 completions → `noReply: true`; final completion → `noReply: false`. Failed exits always `noReply: false`.
- **Description refresh cadence:** Plugin load only. Re-scanning per call adds I/O on the hot path with no benefit.
- **`fkill` for process cleanup:** Use `fkill` npm package (v10.0.3, Jan 2026, 229K weekly downloads, zero dependencies) rather than `tree-kill` (unmaintained since Dec 2019, no SIGTERM→SIGKILL escalation, no timeout). Use `fkill(pid, { force: false, forceTimeout: 2000, waitForExit: 5000 })` pattern. `fkill` v10 requires `pid` as a number (not string); import: `import fkill from 'fkill'`.
- **Cap agent list at 20:** If more, show first 20 + "… and N more (use copilot_list_agents to see all)"; `copilot_list_agents` ships in v1.x.
- **TUI toast on completion:** Yes — call `client.tui.showToast({ body: { message: '<text>', variant: 'success' } })` alongside session-prompt injection. `variant` is non-optional: `'info'|'success'|'warning'|'error'`. Confirmed present in SDK v1.14.21.
- **`TaskState` lifetime:** Keep until plugin shutdown so repeat `copilot_output` calls are idempotent. No `discard` arg in v1.
- **Plugin teardown flag:** `isShuttingDown: boolean` in plugin scope (default `false`). Set during cleanup. All `close` handlers check before calling `promptAsync`; skip and log if shutting down.
- **Concurrent delegation cap:** Default max 10 in-flight tasks. `copilot_delegate` returns a structured error (not a throw) with the running count when the cap is exceeded. Configurable via plugin options in v1.x.
- **Notification timeout:** Per-task 60s timeout from subprocess completion to confirmed `promptAsync` call. On timeout: abort and kill subprocess, log via `client.app.log`, set `status: 'failed'`. Prevents indefinite parent hangs on silent notification failure.

## Open Questions

### Resolved During Planning

- **Repo/package name:** `opencode-copilot-delegate`. Public unscoped npm package, same name.
- **Versioning:** Start at `0.1.0`, stay on `0.x` during initial development (unstable).
- **Cross-session task visibility:** Single-session scope — `TaskState` is in-memory inside one OpenCode process. Cross-process access returns `task_id not found in this OpenCode process`. Document boundary in README.
- **`promptAsync` + `noReply`:** Confirmed in `@opencode-ai/sdk` v1.14.21. Both `prompt()` and `promptAsync()` accept `noReply?: boolean` in body. `promptAsync` returns 204 void (fire-and-forget). `noReply: true` suppresses automatic LLM reply; `noReply: false` forces parent turn.
- **Built-in Copilot agent names:** Confirmed from official docs. All lowercase with hyphens: `explore`, `task`, `general-purpose`, `code-review`, `research`, `critic` (experimental — requires `--experimental` flag). Verify exact list via `copilot agent list` at impl time as a sanity check only.

### Deferred to Implementation

- Does `client.tui.showToast(...)` exist in the current SDK and what is its exact signature? Verify at impl time during T4. If absent, drop Resolved Decision #4 and document in README.
- `noReply: true` behavior with the OpenCode TUI: does an injected message appear in conversation history, or only when the parent next takes a turn? Test during T7 (E2E verification).

## Output Structure

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
│   ├── fixtures/
│   │   ├── happy-path.jsonl
│   │   ├── model-error.jsonl
│   │   ├── multi-tool.jsonl
│   │   └── README.md
│   ├── integration/
│   │   ├── opencode.test.ts        # Server-spawning integration tests (T6.5)
│   │   ├── helpers/
│   │   │   ├── server.ts           # Spawn / health-poll / teardown
│   │   │   └── client.ts           # SDK client factory
│   │   └── fixtures/               # Minimal project dir for spawned server
│   ├── jsonl-parser.test.ts
│   ├── envelope.test.ts
│   ├── agents.test.ts
│   ├── subprocess.test.ts
│   ├── notify.test.ts
│   └── tools.test.ts
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
├── VERIFICATION.md
└── LICENSE
```

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

**Event flow (single delegation):**

```
Parent agent
  → copilot_delegate(prompt, agent?, model?, ...)
      builds CLI args
      spawn('copilot', args) → child process
      registers TaskState under task_id
      returns { task_id } synchronously

Child process (background)
  stdout → line-buffer → JSON.parse each line
          → ParsedEvent → accumulate in state.events
  close event
      → set state.status, endedAt, exitCode
      → build <system-reminder> notification
      → client.session.promptAsync(parentSessionID, { noReply, parts: [notification] })

Parent agent (next turn)
  sees <system-reminder>[COPILOT DELEGATION COMPLETED] in context
  → copilot_output(task_id)
      reads TaskState from registry
      builds structured envelope from events
      returns envelope
```

**`noReply` logic (mirroring OMO):**

```
inFlightCounter[parentSessionID]++  on delegate
const remaining = --inFlightCounter[parentSessionID]  // atomic: decrement before any await

noReply = remaining > 0
          (true while other tasks still running → silent injection)
          (false when last task completes → forces parent turn)
          (always false on failed exit → forces parent turn)
```

**Tool I/O contracts:**

`copilot_delegate` args:
```
prompt: string (required, min 1)
agent?: string
model?: string
add_dir?: string[]
allow_tool?: string[]
deny_tool?: string[]
```
Returns: `{ task_id: string }` — `'cpl_' + uuid v4`.

`copilot_output` args:
```
task_id: string (required, must start with 'cpl_')
block?: boolean (default false)
timeout_ms?: number (default 30000, max 120000)
```
Returns envelope:
```
task_id, status ('running'|'complete'|'failed'|'cancelled'),
exit_code?, agent?, model?, duration_ms,
tokens?, final_message?, tool_calls_summary[],
error?, timed_out?, events_count
```
On registry miss: returns `{ task_id, status: 'unknown', error: '...' }` — does NOT throw.

`copilot_cancel` args: `{ task_id: string }`.
Returns: `{ cancelled: boolean; was_running: boolean }`.
Does NOT throw on unknown `task_id`.

**Notification message shape:**
```
<system-reminder>
[COPILOT DELEGATION COMPLETED]
**Task ID:** `<task_id>`
**Agent:** <agent or "default">
**Model:** <model or "default">
**Duration:** <human-readable>
**Status:** <complete | failed | cancelled>

Use `copilot_output(task_id="<task_id>")` to retrieve the structured result.
</system-reminder>
```
On `status: failed` — append `**ACTION REQUIRED:** Subprocess exited with code <N>.`

**`TaskState` shape:**
```typescript
type TaskState = {
  taskId: string
  parentSessionID: string
  pid: number
  startedAt: number
  endedAt?: number
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  exitCode?: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
  stdoutLineBuffer: string
  events: ParsedEvent[]
  finalMessage?: string
  errorText?: string
  child: ChildProcess
  completionPromise: Promise<void>  // resolved on close; copilot_output block:true races this vs timeout
  abortController: AbortController
}
```

## Implementation Units

- [x] **T1: Repo bootstrap** *(complete)*

**Goal:** Publish an installable npm package skeleton with working build and changeset tooling.

**Requirements:** R6

**Dependencies:** None

**Files:**
- `package.json`, `tsconfig.json`, `biome.json`, `.changeset/config.json`
- `src/index.ts`, `src/tools/delegate.ts`, `src/tools/output.ts`, `src/tools/cancel.ts`
- `src/runtime/task-registry.ts`, `src/runtime/subprocess.ts`, `src/runtime/jsonl-parser.ts`, `src/runtime/notify.ts`, `src/runtime/envelope.ts`
- `src/discovery/agents.ts`, `src/discovery/description.ts`
- `src/lib/ansi.ts`, `src/lib/kill-tree.ts`
- `README.md`, `LICENSE`, `CHANGELOG.md`

**Verification:**
- `bun run build` exits 0, produces `dist/index.js` and `dist/index.d.ts`.
- `cat package.json | jq '.name, .version, .type'` → `"opencode-copilot-delegate"`, `"0.1.0"`, `"module"`.

---

- [ ] **T2.5: JSONL fixture capture** *(can run in parallel with T2; fixture schema draftable from real Copilot output before parser is complete)*

**Goal:** Capture real Copilot CLI JSONL output as test fixtures before writing the parser.

**Requirements:** R1, R2

**Dependencies:** T1, live `copilot` binary

**Files:**
- Create: `tests/fixtures/happy-path.jsonl`
- Create: `tests/fixtures/model-error.jsonl`
- Create: `tests/fixtures/multi-tool.jsonl`
- Create: `tests/fixtures/README.md`

**Approach:**
- Run `copilot -p "Read README.md and summarize in 2 sentences" --output-format json -s --allow-all-tools --no-ask-user --model claude-haiku-4.5 > tests/fixtures/happy-path.jsonl` from inside the plugin repo (so Copilot's allowlist accepts the path).
- Capture three fixtures: happy path, model-not-found error, multi-tool-call session.
- Strip paths under `$HOME` and session-specific identifiers before committing.
- Document fixture provenance and `copilot --version` in `tests/fixtures/README.md`.

**Test scenarios:**
- Happy path: `head -1 tests/fixtures/happy-path.jsonl | jq 'has("type")'` → `true`.
- PII scrub: `grep -RnE '/Users/[^/]+/|/home/[^/]+/' tests/fixtures/` → no matches.
- Non-empty: `wc -l tests/fixtures/*.jsonl` — each fixture has at least one line.

**Verification:**
- All four files exist; each `.jsonl` is valid JSON per line; `README.md` contains `copilot --version` output.

---

- [ ] **T2: JSONL parser + envelope builder**

**Goal:** Parse Copilot CLI JSONL stdout into typed events; fold events into the structured `copilot_output` envelope.

**Requirements:** R1, R2

**Dependencies:** T1, T2.5

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle strictly. Write failing tests first (`bun test` must fail), then implement until green, then refactor without breaking green. All test files use BDD structure (`describe` / `it`) with Given-When-Then comments on each `it` block. Write failing tests in `tests/jsonl-parser.test.ts` and `tests/envelope.test.ts` against the fixture contracts before writing `src/runtime/jsonl-parser.ts` and `src/runtime/envelope.ts`.

**Files:**
- Modify: `src/runtime/jsonl-parser.ts`
- Modify: `src/runtime/envelope.ts`
- Test: `tests/jsonl-parser.test.ts`
- Test: `tests/envelope.test.ts`

**Approach:**
- `jsonl-parser.ts`: line buffer + `JSON.parse` per line, defensive (skip malformed lines, log via `client.app.log`).
- Output type: `ParsedEvent = { type: 'message' | 'tool_use' | 'tool_result' | 'usage' | 'error' | 'unknown', ...payload }`.
- `envelope.ts`: fold `ParsedEvent[]` into the full envelope shape; every field optional-safe.

**Patterns to follow:**
- `devopspass/devopspass` `agent_events.py` parsing patterns (reference in memory).
- `cloveric/cc-telegram-bridge` `process-adapter.ts` accumulator pattern.

**Test scenarios:**
- Happy path: parse happy-path fixture → envelope has non-empty `final_message`, correct `events_count`.
- Tool aggregation: multi-tool fixture → `tool_calls_summary` aggregates correctly.
- Error path: model-error fixture → `status: 'failed'`, `error` contains stderr tail.
- Malformed lines: skip malformed lines without throwing; `unknown` type returned.
- Missing usage: degrade gracefully when no usage event present (`tokens` is undefined, not error).
- Integration: `buildEnvelope({events: [], status: 'running', startedAt: Date.now()})` returns object with required keys.

**Verification:**
- `bun test tests/jsonl-parser.test.ts tests/envelope.test.ts` exits 0.
- `bun -e "import {parseJsonlLine} from './src/runtime/jsonl-parser.ts'; console.log(parseJsonlLine('not-json').type)"` prints `unknown`.

---

- [ ] **T3: Subprocess wrapper + registry**

**Goal:** Spawn the `copilot` process, line-buffer its stdout through the JSONL parser, manage `TaskState` in the registry, and support cancellation.

**Requirements:** R1, R4

**Dependencies:** T2

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle strictly. Write failing tests first (`bun test` must fail), then implement until green, then refactor without breaking green. All test files use BDD structure (`describe` / `it`) with Given-When-Then comments on each `it` block. Write failing tests in `tests/subprocess.test.ts` (using `bash -c` fixture spawns) before implementing `src/runtime/subprocess.ts`, `src/lib/kill-tree.ts`, and `src/lib/ansi.ts`.

**Files:**
- Modify: `src/runtime/subprocess.ts`
- Modify: `src/runtime/task-registry.ts`
- Modify: `src/lib/kill-tree.ts`
- Modify: `src/lib/ansi.ts`
- Test: `tests/subprocess.test.ts`

**Approach:**
- `subprocess.ts`: `spawn` with explicit env (preserve auth precedence), `cwd = directory`, line-buffered stdout pipe.
- `task-registry.ts`: `Map<string, TaskState>` at plugin scope; keyed by `cpl_` + UUID v4; clean up on plugin shutdown.
- **`lib/kill-tree.ts`:** use `fkill` npm package rather than rolling our own. `fkill(pid, { force: false, forceTimeout: 2000, waitForExit: 5000 })`. PID must be a number.
- `lib/ansi.ts`: strip ANSI before storing `finalMessage`.
- On `close` event: set `endedAt`, `status` from exit code.

**Patterns to follow:**
- `cloveric/cc-telegram-bridge` `process-adapter.ts` for spawn pattern and accumulator structure.

**Test scenarios:**
- Happy path: spawn → close → `status: 'complete'` on exit 0.
- Error path: spawn → close → `status: 'failed'` on non-zero exit.
- Line buffering: partial JSONL across chunk boundaries accumulates correctly.
- Cancellation: kill-tree terminates child + grandchild process within 3 seconds.
- ANSI stripping: `stripAnsi('\x1b[31mred\x1b[0m')` → `red`.

**Verification:**
- `bun test tests/subprocess.test.ts` exits 0.

---

- [ ] **T4: Notification injection**

**Goal:** Inject `<system-reminder>` notifications into the parent session when a Copilot subprocess completes, with correct `noReply` semantics mirroring OMO.

**Requirements:** R2

**Dependencies:** T3

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle strictly. Write failing tests first (`bun test` must fail), then implement until green, then refactor without breaking green. All test files use BDD structure (`describe` / `it`) with Given-When-Then comments on each `it` block. Write failing tests in `tests/notify.test.ts` with a mocked `client.session.promptAsync` before implementing `src/runtime/notify.ts`.

**Files:**
- Modify: `src/runtime/notify.ts`
- Test: `tests/notify.test.ts`

**Approach:**
- `notify.ts`: wrapper around `client.session.promptAsync` with the `<system-reminder>` template.
- Track per-parent-session in-flight count: decrement on each close, set `noReply = count > 0`.
- Failed exits always `noReply: false` regardless of in-flight count.
- Call `client.tui.showToast({ body: { message: '<text>', variant: 'success' } })` alongside (confirmed in SDK v1.14.21). `variant` is non-optional.

**Test scenarios:**
- In-flight counter: with 3 tasks, completing #1 → `noReply: true`; completing #3 (last) → `noReply: false`.
- Multi-session isolation: sessions A and B each have tasks; interleave completions; assert each session's `noReply` is isolated by `parentSessionId` (completing A's last task must not affect B's counter).
- Failed status forces turn: `status: 'failed'` always sets `noReply: false`.
- Notification shape: `body.parts[0].text` contains `<system-reminder>` and `[COPILOT DELEGATION COMPLETED]` literals.
- `noReply` never undefined: explicitly set (not left as `undefined`).
- Integration (manual): in a real OpenCode session, invoke `copilot_delegate` → `<system-reminder>` appears as a turn.

**Verification:**
- `bun test tests/notify.test.ts` exits 0.
- In a real OpenCode session: `copilot_delegate({prompt: 'echo PONG', model: 'claude-haiku-4.5'})` returns `task_id` within 500ms; `<system-reminder>` block with `[COPILOT DELEGATION COMPLETED]` appears in a subsequent turn.

---

- [ ] **T5: Agent discovery + description**

**Goal:** Build the `copilot_delegate` tool description by merging built-in, user, and repo Copilot agents at plugin load.

**Requirements:** R3

**Dependencies:** T1

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle strictly. Write failing tests first (`bun test` must fail), then implement until green, then refactor without breaking green. All test files use BDD structure (`describe` / `it`) with Given-When-Then comments on each `it` block. Write failing tests in `tests/agents.test.ts` using fixture agent directories before implementing `src/discovery/agents.ts` and `src/discovery/description.ts`.

**Files:**
- Modify: `src/discovery/agents.ts`
- Modify: `src/discovery/description.ts`
- Test: `tests/agents.test.ts`
- Create: `tests/fixtures/agents/` (user + repo fixture dirs)

**Approach:**
- `agents.ts`: scan `~/.copilot/agents/*.md` and `<directory>/.github/agents/*.md` (runtime paths, resolved at execution time — not repo-relative paths in the plugin source).
- Merge order: built-in first, then user, then repo. Repo agent overrides user agent with same name.
- Built-in agent list: verify actual names via `copilot agent list` at impl time. Brainstorm listed "Explore", "Task", "General-purpose", "Code-review" — confirm casing.
- `description.ts`: render merged list as multi-line string. Cap at 20 entries.
- Missing agent dirs return empty list, no throw.

**Test scenarios:**
- Ordering: built-in agents listed first.
- User merge: agents from `~/.copilot/agents/` appear after built-in.
- Repo merge: agents from `.github/agents/` appear after user.
- Override: repo agent with same name as user agent replaces it.
- Graceful degradation: missing agent dir → empty list, no throw.
- Description output: contains "Available Copilot agents", lists `default (builtin)` first, includes `(user)` and `(repo)` labels.
- Non-existent paths: `buildDescription('/nonexistent')` returns string containing `default (builtin)`.

**Verification:**
- `bun test tests/agents.test.ts` exits 0.

---

- [ ] **T6: Tool wiring**

**Goal:** Wire the three tools and plugin entrypoint; integration-test with a stubbed `PluginInput`.

**Requirements:** R1, R2, R3, R4

**Dependencies:** T2, T3, T4, T5

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle strictly. Write failing tests first (`bun test` must fail), then implement until green, then refactor without breaking green. All test files use BDD structure (`describe` / `it`) with Given-When-Then comments on each `it` block. Write failing integration tests in `tests/tools.test.ts` with a stubbed `PluginInput` before wiring `src/tools/*.ts` and `src/index.ts`.

**Files:**
- Modify: `src/tools/delegate.ts`
- Modify: `src/tools/output.ts`
- Modify: `src/tools/cancel.ts`
- Modify: `src/index.ts`
- Test: `tests/tools.test.ts`

**Approach:**
- `delegate.ts`: build args, call subprocess wrapper, register `TaskState`, return `{ task_id }`. Throw on missing `copilot` binary with clear install hint.
- `output.ts`: read state, build envelope. When `block: true`, await close event up to `timeout_ms`; on timeout return current state with `timed_out: true`. When `block: false`, return immediately.
- `cancel.ts`: SIGTERM → 2s grace → SIGKILL escalation. Set `status: 'cancelled'`, fire notification. Return `{ cancelled, was_running }`.
- `index.ts`: export `Plugin` that registers all three tools, wires `client` into runtime.
- `copilot_output` and `copilot_cancel` validate at the tool boundary: `task_id` must be non-empty and match the `cpl_` prefix; malformed inputs return a structured error envelope without throwing.

**Test scenarios:**
- Happy path: `copilot_delegate` returns `task_id` matching `/^cpl_[0-9a-f-]+$/`.
- Unknown task: `copilot_output` returns `status: 'unknown'` for missing task_id — does not throw.
- Malformed task_id: `copilot_output({task_id: ''})` and `copilot_output({task_id: 'bad_id'})` return structured error envelopes without throwing.
- Unknown cancel: `copilot_cancel` returns `{cancelled: false, was_running: false}` for missing task_id.
- Blocking mode: `copilot_output({task_id, block: true, timeout_ms: 500})` returns `timed_out: true` when subprocess outlasts timeout.
- Near-timeout race: `completionPromise` resolves just before `timeout_ms` fires — result must not be `timed_out: true`.
- Tool registration: `Object.keys(result.tool).sort()` → `['copilot_cancel', 'copilot_delegate', 'copilot_output']`.
- Description non-trivial: `result.tool.copilot_delegate.description.length > 50` → `true`.

**Verification:**
- `bun run build && bun test tests/tools.test.ts` exits 0.
- `bun run build` produces `dist/index.js` + `dist/index.d.ts`.

---

- [ ] **T6.5: OpenCode server integration tests**

**Goal:** Automated integration tests that spawn a real OpenCode server subprocess with the plugin installed, send actual session prompts via the SDK client, and assert on tool execution results — validating the full plugin lifecycle without manual steps.

**Requirements:** R1, R2, R3

**Dependencies:** T6 (tools must exist to test)

**Execution note (TDD — mandatory):** Red-Green-Refactor cycle. Write the test scaffolding (server spawn, health poll, SDK client setup, teardown) first — tests will fail because tools don't exist yet. Implement tools in T2–T6 until tests pass. BDD structure (`describe` / `it`) with Given-When-Then comments on each `it`. Do **not** mock the OpenCode server; use a real spawned process.

**Files:**
- New: `tests/integration/opencode.test.ts`
- New: `tests/integration/helpers/server.ts` — server lifecycle (spawn, health poll, teardown)
- New: `tests/integration/helpers/client.ts` — SDK client factory
- New: `tests/integration/fixtures/` — minimal `package.json` + plugin config for test project directory

**Approach:**
- `server.ts`: `Bun.spawn(['opencode', 'serve', '--port', PORT])` in a temp project dir with plugin symlinked; poll `GET /global/health` at 100ms intervals up to 30s before resolving.
- `client.ts`: `createOpencodeClient({ baseUrl: 'http://127.0.0.1:PORT', throwOnError: true })`.
- Teardown: SIGTERM → 5s grace → SIGKILL (matching librarian-researched pattern).
- Plugin loading: place built `dist/index.js` in `tests/integration/fixtures/.opencode/plugins/` (or symlink); OpenCode auto-loads on server start.
- Port: use ephemeral allocation — `Bun.spawn(['opencode', 'serve', '--port', '0', ...])` (or equivalent); read the assigned port from subprocess stdout or a startup-ready signal; `server.ts` returns the resolved base URL. If the subprocess exits before the health check completes, `server.ts` throws immediately with the last N lines of stderr.
- Unique test isolation: each `describe` block uses its own session; sessions are deleted in `afterEach`.

**Test scenarios:**
- Server starts and `/global/health` returns `{ ok: true }` within 10s.
- `copilot_delegate` tool is discoverable via session message tool-use parts.
- Given a prompt that invokes `copilot_delegate`, when the session completes, then `task_id` matching `/^cpl_[0-9a-f-]+$/` appears in the assistant message.
- Given a `task_id` from `copilot_delegate`, when `copilot_output` is called with `block: true`, then it returns within `timeout_ms` with either output or `timed_out: true`.
- Given a running task, when `copilot_cancel` is called, then `{ cancelled: true, was_running: true }` is returned.
- Given a nonexistent `task_id`, when `copilot_output` is called, then `{ status: 'unknown' }` is returned without throwing.
- `<system-reminder>` notification appears as a subsequent assistant turn after `copilot_delegate` completes — assert by polling session messages with bounded timeout (max 30s, 250ms interval) until the reminder turn is found.
- Server shuts down cleanly after SIGTERM within 5s (no zombie processes).

**Verification:**
- `bun test tests/integration/` exits 0 with all scenarios passing.
- No leftover `opencode` processes after test run (`pgrep opencode` returns empty).

---

- [ ] **T7: End-to-end manual verification**

**Goal:** Exercise all user-facing behaviors in a real OpenCode session before tagging v0.1.0. Capture results in `VERIFICATION.md`.

**Requirements:** R1, R2, R3, R4

**Dependencies:** T6

**Files:**
- Create: `VERIFICATION.md`
- Create: `docs/e2e-checklist.md` (reproducible checklist for future manual verification runs)

**Approach:** Each scenario must be exercised in a real OpenCode session with the plugin installed. Record ✅/❌ + notes for each.

**Test scenarios:**
1. Happy path: `copilot_delegate({ prompt: 'Read README.md and summarize what this plugin does in 2 sentences.', model: 'claude-haiku-4.5' })` → `task_id` returned synchronously; parent reads another file; `<system-reminder>` arrives; `copilot_output(task_id)` returns envelope with non-empty `final_message`.
2. Cancellation mid-flight: delegate a long-running prompt; `copilot_cancel` after 5s; verify SIGTERM → SIGKILL works; `copilot_output` returns `status: 'cancelled'` with partial transcript.
3. Failed exit: delegate with `model: 'nonexistent-model-name'`; `<system-reminder>` arrives with `Status: failed`; `noReply: false` forces a parent turn; envelope contains stderr tail in `error`.
4. Concurrent delegations: fire 3 delegations back-to-back; only LAST completion sets `noReply: false`; per-parent-session in-flight counter decrements correctly even when one fails.
5. Blocking mode: delegate a ~10s task; immediately `copilot_output({ task_id, block: true, timeout_ms: 3000 })` → `timed_out: true`; then call again without `block` → final state after subprocess finishes.
6. Plugin reload mid-flight: delegate, then trigger OpenCode restart; verify orphaned subprocess is documented in README as a known v1 limitation.
7. TUI toast: verify `client.tui.showToast(...)` fires on completion; verify behavior when session is focused vs background; if it double-fires, drop the toast.
8. Description string accuracy: with one agent in `~/.copilot/agents/test-agent.md` and one in `<repo>/.github/agents/repo-agent.md`, restart OpenCode, inspect tool catalog — both appear with correct `(user)` / `(repo)` labels; built-in agents listed first.

**Verification:**
- `VERIFICATION.md` exists with ✅/❌ result recorded for all 8 scenarios.

---

- [ ] **T8: Skill update**

**Goal:** Update `~/.agents/skills/copilot-cli/SKILL.md` to branch on plugin presence. Ships with v0.1.0.

**Requirements:** R5

**Dependencies:** T7 (plugin must be verified before updating the skill)

**Files:**
- Modify: `~/.agents/skills/copilot-cli/SKILL.md` (external, via dotfiles bare-repo workflow)

**Approach:**
- Add runtime branch at the top of the skill: "If your tool catalog includes `copilot_delegate`, `copilot_output`, and `copilot_cancel` (provided by `opencode-copilot-delegate`), prefer those tools. See plugin README for tool args. Otherwise, use the direct subprocess pattern below."
- Existing manual subprocess content stays unchanged beneath the branch.
- Commit through the dotfiles bare-repo workflow.

**Test scenarios:**
- Branch present: `head -20 ~/.agents/skills/copilot-cli/SKILL.md | grep -F 'copilot_delegate'` → matches.
- Diff: `GIT_DIR=$HOME/.dotfiles GIT_WORK_TREE=$HOME git diff -- .agents/skills/copilot-cli/SKILL.md` shows branch added at top, original content unchanged below.
- In a fresh OpenCode session with plugin: invoke the skill → agent references `copilot_delegate` instead of constructing raw `copilot -p ...`.

**Verification:**
- `GIT_DIR=$HOME/.dotfiles GIT_WORK_TREE=$HOME git diff -- .agents/skills/copilot-cli/SKILL.md` shows only the expected branch addition.

---

- [ ] **T9: Publish**

**Goal:** Publish `opencode-copilot-delegate@0.1.0` to npm, tag the release, and install in Marcus's OpenCode config.

**Requirements:** R6

**Dependencies:** T8

**Files:**
- `package.json` (version bump via changeset)
- `CHANGELOG.md` (generated)
- `~/.config/opencode/opencode.json` (add plugin entry)

**Approach:**
- `bun run build` → `dist/`.
- `npm publish --access=public`.
- Tag `v0.1.0`, push to GitHub, generate release notes from `.changeset/`.
- Add to Marcus's installed plugins: `"plugin": ["opencode-copilot-delegate"]` in `~/.config/opencode/opencode.json`.

**Test scenarios:**
- Published: `npm view opencode-copilot-delegate version` → `0.1.0`.
- Release: `gh release view v0.1.0 --repo marcusrbrown/opencode-copilot-delegate --json tagName,isLatest` → `isLatest: true`.
- Installed: restart OpenCode; tool catalog includes `copilot_delegate`, `copilot_output`, `copilot_cancel`.
- Config: `jq '.plugin' ~/.config/opencode/opencode.json` → array contains `"opencode-copilot-delegate"`.

**Verification:**
- All four test scenarios pass.

---

- [ ] **T10: Dotfiles PR for skill update**

**Goal:** Land the `copilot-cli` skill update in the `.dotfiles` repo via a PR.

**Requirements:** R5

**Dependencies:** T9 (reference published version in PR body)

**Files:**
- `.agents/skills/copilot-cli/SKILL.md` in `marcusrbrown/.dotfiles` (single-file PR)

**Approach:**
- Branch `skills/copilot-cli-plugin-branch` off `main`.
- Single commit with the branch addition from T8.
- PR body links to plugin repo + v0.1.0 release notes + this plan.

**Test scenarios:**
- PR state: `gh pr view --repo marcusrbrown/.dotfiles --json state,headRefName,mergeable` → open, correct branch, mergeable.
- Single-file: `gh pr view --repo marcusrbrown/.dotfiles --json files | jq '.files[].path'` → exactly `.agents/skills/copilot-cli/SKILL.md`.
- Checks: all required CI checks pass.
- PR body: contains links to plugin repo, v0.1.0 release notes, and this plan.

**Verification:**
- PR open, all checks passing.

---

- [ ] **T11: CI / quality gates**

**Goal:** Add GitHub Actions CI workflow; set branch protection on `main`.

**Requirements:** R6

**Dependencies:** T11 *(gate enables after integration tests pass)*

**Files:**
- Create: `.github/workflows/ci.yml`

**Approach:**
- Install Bun, `bun install`, `bun test`, `bun run typecheck` (`tsc --noEmit`), `bun run lint`.
- Install `opencode` binary before running `bun test tests/integration/` — download from `anomalyco/opencode` GitHub releases (see `fro-bot/agent` `src/services/setup/opencode.ts` for the platform detection + download pattern). T6.5 integration tests fail loudly if `opencode` is not on PATH.
- Branch protection on `main` requires `ci` to pass.
- `.changeset/` config: PRs without a changeset for `src/**` changes fail CI.
- Pre-commit: optional husky hook running `bun run typecheck` on staged TS files.
- **Security:** Pin all GitHub Actions to full commit SHAs in `ci.yml`; use `permissions: read-all` at workflow level, with `contents: write` added only for jobs that need to write (e.g., publish).

**Test scenarios:**
- Workflow present: `gh workflow list --repo marcusrbrown/opencode-copilot-delegate` includes `ci`.
- CI passes: push on a throwaway branch → `gh run list --workflow=ci.yml --limit 1 --json conclusion` → `success`.
- Branch protection: `gh api repos/marcusrbrown/opencode-copilot-delegate/branches/main/protection --jq '.required_status_checks.contexts'` → includes `ci`.
- Changeset gate: PR touching `src/**` without changeset → gate fails; add changeset → passes.
- Local check: `bun install && bun test && bun run typecheck && bun run lint` → all exit 0.

**Verification:**
- All five scenarios pass.

## System-Wide Impact

- **Interaction graph:** Plugin hooks into the OpenCode tool dispatch (via `PluginInput`) and injects messages into the parent session via `client.session.promptAsync`. No other callbacks or middleware involved.
- **Error propagation:** `copilot_delegate` throws on missing binary. `copilot_output` and `copilot_cancel` never throw on unknown task_id — they return structured error envelopes. Subprocess failures surface via `status: 'failed'` + forced `noReply: false` turn.
- **`promptAsync` failure handling:** `promptAsync` can throw (network error, session expired, OpenCode restart). All `close` handlers must wrap `promptAsync` in try/catch. On failure: log via `client.app.log`, store `notifyError` in `TaskState`, expose in `copilot_output` envelope so the parent can detect "task completed but notification failed" and retrieve the result manually. This also covers the case where `promptAsync` is called against a dead session ID (parent session ended before subprocess finished) — treat any throw as a notification failure, not a fatal error.
- **Plugin teardown safety:** Maintain an `isShuttingDown: boolean` flag (default `false`). Set to `true` during plugin cleanup. The subprocess `close` handler must check this flag before calling `promptAsync` and skip notification (log instead) if shutting down. This prevents the close callback from calling `promptAsync` on a dead `client` reference after plugin unload.
- **Concurrent delegation cap:** `copilot_delegate` enforces a configurable max-concurrent-tasks limit (default 10). Exceeding it returns a structured error response (not a throw) with the current running count. Each task opens 3 stdio pipes; no cap risks exhausting OS FD limits (256 on macOS, 1024 on Linux), which would crash the entire OpenCode process.
- **`completionPromise` rejection:** Every `await` on `completionPromise` must be wrapped in try/catch. Rejection reason (non-zero exit, spawn error, parse failure) must be converted to a typed error before returning — never swallowed. Floating unhandled rejections are a process crash on Node ≥15.
- **State lifecycle risks:** `TaskState` persists until plugin shutdown; plugin restart orphans in-flight subprocesses (documented v1 limitation). No cleanup hook exists across OpenCode restarts.
- **API surface parity:** All three tools expose consistent `task_id` routing; `copilot_output` envelope is the single source of truth for task state — no state leaks through other return paths.
- **Integration coverage:** T7 (manual E2E) is the primary cross-layer coverage. Unit tests stub `PluginInput`; real behavior requires a live `copilot` binary and OpenCode session.
- **Unchanged invariants:** The plugin does not modify OpenCode session state directly — it only injects messages via the documented `promptAsync` API. Other OpenCode plugins, tools, and sessions are unaffected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Plugin restart mid-delegation → orphaned `copilot` subprocess. | Document in README. v1.x: PID file under `${XDG_RUNTIME_DIR}/opencode-copilot-delegate/<task_id>.pid`; plugin start reaps stale PIDs. |
| Copilot CLI changes JSONL schema. | Defensive parsing (every field optional, unknown event types stored verbatim). Snapshot real JSONL fixtures at v0.1.0 to detect drift via tests. |
| **RESOLVED:** `promptAsync` + `noReply` API compatibility. | Confirmed: use `prompt()` (not `promptAsync()`) with `noReply` for notification injection. `promptAsync` does not accept `noReply`; `opencode-pty` reference confirms `prompt` with `noReply: true`. This is a known API constraint, not a runtime verification item. |
| Description string bloats with many user agents. | Cap merged list at 20; show "… and N more" + ship `copilot_list_agents` in v1.x. |
| Auth misconfiguration (stale `GH_TOKEN` overrides login) → silent failures. | Plugin logs resolved auth source via `client.app.log` at delegate start (token value never logged). |
| Built-in Copilot agent names guessed wrong. | Verify via `copilot agent list` at impl time. Hardcoded list lives in one place (`src/discovery/agents.ts`). |
| `fkill` double-kill race — PID recycled between cancel decision and kill execution. | Before calling `fkill`, check whether `completionPromise` has already settled. If yes, treat cancel as a no-op (process already exited cleanly). Never call `fkill` on a settled task. |
| `completionPromise` rejection unhandled — non-zero CLI exit or spawn error. | Every `await completionPromise` must be try/caught. Rejection must be converted to a typed error; never swallowed. Floating unhandled rejections crash Node ≥15. |
| Silent notification / prompt timeout — parent never sees `<system-reminder>` (v1 requirement). | Implement per-task notification timeout (default 60s). On timeout: abort subprocess, kill via `fkill`, log warning via `client.app.log`, set `status: 'failed'` with descriptive error in envelope. No silent hangs. |
| `promptAsync` or `prompt` throws on dead/expired session. | Treat any throw from the notify call as a notification failure (see System-Wide Impact). Log, store `notifyError` in `TaskState`, do not rethrow. |
| OpenCode SDK breaking changes post-publish invalidate plugin API calls. | Pin `@opencode-ai/sdk` and `@opencode-ai/plugin` to exact versions in `package.json`. Add a compatibility matrix to README. Consider runtime version check at plugin load that warns (not crashes) if SDK version is outside tested range. |
| `fkill` flakiness on macOS vs Linux. | Use `fkill` npm package (v10.0.3, actively maintained, zero dependencies, SIGTERM→SIGKILL escalation with `forceTimeout`) instead of `tree-kill` (unmaintained Dec 2019). |

## Documentation / Operational Notes

- README must include a `Privacy` section: plugin collects zero telemetry, never phones home, all logging via `client.app.log`, auth token value never logged (only auth source name).
- Document known v1 limitation: orphaned subprocesses on plugin restart.
- Document cross-session task visibility boundary: `TaskState` is in-memory per OpenCode process.
- `VERIFICATION.md` must be checked in before tagging v0.1.0 with results from all T7 scenarios.

## Sources & References

- **Brainstorm (origin):** `~/.context/systematic/ce-brainstorm/2026-04-21-copilot-delegate-plugin-requirements.md`
- **Ideation:** `~/.context/systematic/ce-ideation/2026-04-21-copilot-cli-delegation.md`
- **Copilot CLI skill:** `~/.agents/skills/copilot-cli/SKILL.md`
- **OMO async notification:** Verified against `oh-my-openagent@3.17.4` — `client.session.promptAsync` with `noReply: !allComplete`; `createInternalAgentTextPart`; `OMO_INTERNAL_INITIATOR_MARKER`
- **OpenCode SDK types:** `@opencode-ai/sdk` — `SessionPromptData.body.noReply` and `SessionPromptAsyncData.body.noReply` both accept `noReply?: boolean`
- **Public session injection reference:** `shekohex/opencode-pty` — `src/plugin.ts`
- **Subprocess wrapping reference:** `cloveric/cc-telegram-bridge` — `src/codex/process-adapter.ts`
- **Plugin tool API reference:** `marcusrbrown/systematic` repo
- **OpenCode plugin types:** `@opencode-ai/plugin` v0.14.0
- **Copilot CLI custom agents:** <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-agents/invoke-custom-agents>
- **Copilot CLI delegation patterns:** <https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-agents/delegate-tasks-to-cca>
