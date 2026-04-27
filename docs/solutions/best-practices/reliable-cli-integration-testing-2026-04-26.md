---
title: Reliable integration testing for OpenCode plugins via CLI invocations
date: 2026-04-26
category: best-practices
module: integration_tests
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - Building integration tests for an OpenCode plugin that exercises tool execution end-to-end
  - Choosing between an SDK harness (`opencode serve` + `createOpencodeClient`) and a CLI subprocess
  - Diagnosing test timeouts that look like plugin-loading or tool-calling regressions
  - Selecting a default model for a CI test suite
tags:
  - opencode
  - integration-testing
  - cli-invocations
  - rate-limits
  - isolation
  - spawn-sync
  - model-selection
---

# Reliable integration testing for OpenCode plugins via CLI invocations

## Context

The first integration suite for this plugin was SDK-based: a `helpers/server.ts` module spawned `opencode serve --port 0`, parsed the ephemeral port from stdout, polled `/global/health`, then helpers wrapped `createOpencodeClient` and `session.prompt`/`session.promptAsync`. To prevent user-config bleed-through from plugins like Magic Context or OMO, the harness grew heavy isolation: `HOME` redirect, all `XDG_*` dirs, `OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_CONFIG_CONTENT`, native opencode binary resolver. After all that, tests against the free `opencode/big-pickle` model returned `assistant[]` arrays with no tool parts and no errors, and several hours were lost theorizing about upstream tool-calling regressions, plugin-loading hangs, and isolation bugs. The actual cause was a `429 Rate limit exceeded` from `https://opencode.ai/zen/v1/messages` — invisible because opencode silently retries on `isRetryable: true` until the test framework times out. The correct primitive turned out to be much simpler: invoke `opencode run` as a subprocess with a paid model, use the minimum isolation that actually matters, and stay out of the SDK harness business entirely.

## Guidance

For integration tests of an OpenCode plugin:

- **Drive `opencode run` directly via `node:child_process.spawnSync`** instead of `opencode serve` + the SDK. No port management, no health polling, no SDK version coupling.
- **Default to a paid model** (`opencode/minimax-m2.5`) for reliability. Free models on `opencode.ai/zen` (e.g., `opencode/big-pickle`) have per-account rate limits that get burned through quickly during failing test loops, surfacing as opaque test timeouts. Allow override via `OPENCODE_TEST_MODEL` env var so individual developers can use free models when their per-account quota is fresh.
- **Minimum isolation**: `OPENCODE_CONFIG_DIR=<empty temp dir>` skips the user's `~/.config/opencode/opencode.json` (which is what was loading Magic Context / OMO). `OPENCODE_CONFIG_CONTENT` registers `dist/index.js` as a plugin via a `file://` URL. Avoid HOME / XDG redirection unless you have evidence of needing more — the heavy harness was solving the wrong problem.
- **ENOBUFS guardrail**: do not leave `--print-logs` on inside test commands. `spawnSync`'s default 1 MB stdout/stderr buffer overflows fast under DEBUG logging and the OS kills the process with `ENOBUFS` / `SIGTERM`. If you need logs temporarily for debugging, bump `maxBuffer` to ~50 MB. See the sibling learning [Diagnosing OpenCode failures with debug logs](../developer-experience/opencode-debug-diagnostics-2026-04-26.md) for the recipe.
- **Auth forwarding**: pass `COPILOT_PAT` (or `GH_TOKEN`) via the `env` option on `spawnSync` rather than mutating `process.env`. Mutating the parent process leaks state across tests.
- **Assertion shape**: regex on `result.stdout` works for the simple case but is vulnerable to LLM-text false positives. Future improvement: parse `opencode run --format json` event stream for actual tool-invocation parts. Tracked separately.

## Why This Matters

The SDK rabbit hole burned roughly six hours and many tokens chasing isolation, plugin-loading, and tool-calling-regression theories — none of which were the cause. The CLI primitive has fewer moving parts (no port management, no health endpoint, no SDK version coupling), repeats reliably across local/CI/cousin repos (Systematic, fro-bot/agent), and survives OpenCode upgrades that would otherwise break the SDK harness. Picking a paid model as the default removes the single highest source of CI flakiness: free-model rate limiting that masquerades as everything else.

## When to Apply

- Writing integration tests for an OpenCode plugin that need end-to-end coverage of tool execution.
- Choosing between an SDK harness and a CLI subprocess for test automation.
- Diagnosing test timeouts that resemble plugin-loading issues, tool-calling regressions, or isolation bugs — switch to the CLI shape and run `opencode run --print-logs --log-level DEBUG` first to surface API-level errors before forming theories.
- Selecting a default model for a CI test suite where reliability outweighs per-run cost.

## Examples

### Minimal test helper

```ts
import {spawnSync, type SpawnSyncReturns} from 'node:child_process'
import {dirSync} from 'tmp'

interface RunArgs {
  model?: string
  prompt: string
  pluginUrl: string
  copilotPat?: string
}

export function runOpencode(args: RunArgs): SpawnSyncReturns<string> {
  const model = args.model ?? process.env.OPENCODE_TEST_MODEL ?? 'opencode/minimax-m2.5'
  const configDir = dirSync({unsafeCleanup: true}).name
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({plugin: [args.pluginUrl]}),
  }
  // copilotPat is forwarded as GH_TOKEN — see auth precedence in README
  // (COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN > ~/.copilot/auth).
  if (args.copilotPat) env.GH_TOKEN = args.copilotPat
  return spawnSync('opencode', ['run', '--model', model, args.prompt], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
    // Default 1MB. Bump to 50_000_000 only if you add --print-logs --log-level DEBUG.
  })
}

export function assertOk(result: SpawnSyncReturns<string>): void {
  if (result.status !== 0) {
    throw new Error(`opencode run exited ${result.status}; stderr tail:\n${result.stderr.slice(-2_000)}`)
  }
}
```

### Before / after

Before (SDK harness, simplified):

```ts
const server = await startServer({port: 0, isolation: deepIsolation()})
const client = makeClient(server.baseUrl)
const session = await client.session.create()
await client.session.prompt({path: {id: session.id}, body: {parts: [{type: 'text', text: 'PING'}]}})
const messages = await client.session.messages({path: {id: session.id}})
expect(extractText(messages)).toMatch(/PONG/)
await server.stop()
```

After (CLI subprocess):

```ts
const result = runOpencode({prompt: 'Reply with exactly PONG.', pluginUrl: `file://${distPath}/index.js`})
assertOk(result)
expect(result.stdout).toMatch(/PONG/)
```

### Cancel-running test (avoiding LLM false positives)

The cancel test asks the LLM to delegate then cancel in a single prompt. To avoid false positives where chatty LLM prose contains the word "cancelled" or "true" without the tool actually running, assert on **both**:

```ts
const result = runOpencode({
  prompt:
    'Use copilot_delegate to start a task that runs "sleep 30 && echo done", then immediately use copilot_cancel ' +
    'on the returned task_id. After cancellation, confirm by stating exactly: cancelled true',
  pluginUrl: `file://${distPath}/index.js`,
  copilotPat: process.env.COPILOT_PAT,
})
assertOk(result)
expect(result.stdout).toMatch(/cancel(led|ed)/i)
expect(result.stdout).toMatch(/\btrue\b/)
```

The `\btrue\b` boundary requires `true` as a standalone token, not embedded in prose like "the truest test of …".

## Related

- Sibling learning: [Diagnosing OpenCode failures with debug logs](../developer-experience/opencode-debug-diagnostics-2026-04-26.md) — the diagnostic recipe that surfaced the rate-limit root cause behind this rebuild.
- Implementation: `tests/integration/opencode.test.ts`
- Tracking issue: re-add integration tests to CI once the cost-vs-signal call is settled (#38).
