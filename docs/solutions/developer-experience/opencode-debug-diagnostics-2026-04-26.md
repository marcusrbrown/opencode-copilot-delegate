---
title: Diagnosing OpenCode failures with debug logs
date: 2026-04-26
category: developer-experience
module: opencode_runtime
problem_type: developer_experience
component: development_workflow
severity: medium
applies_when:
  - An opencode test or invocation hangs or times out without an obvious local cause
  - "build · model" stalls without progress, or `assistant[]` comes back empty
  - You suspect an upstream regression, plugin-loading bug, or isolation problem
  - Anytime you find yourself forming a theory before reading logs
tags:
  - opencode
  - debugging
  - print-logs
  - log-level
  - rate-limit
  - api-errors
  - troubleshooting
---

# Diagnosing OpenCode failures with debug logs

## Context

OpenCode hides API-level errors behind silent retries: any response marked `isRetryable: true` (rate limits, transient 5xx, provider blips) is reattempted internally without surfacing to the caller. Test frameworks compound the problem by killing spawned `opencode` processes at their timeout boundary (typically 60–120s), discarding whatever the runtime would have logged. The result is a stream of misleading symptoms — empty `assistant[]` arrays, `build · <model>` stalls, opaque test timeouts — that look like everything except the rate limit, auth failure, or provider outage that's actually responsible. The escape hatch is `--print-logs --log-level DEBUG`, which redirects opencode's structured logs to stdout/stderr where the test framework (or a shell redirect) can capture them. Used as the first move on any opencode failure, it cuts diagnosis time from hours to minutes.

## Guidance

When investigating any opencode failure that doesn't have an obvious local cause:

1. **Capture full DEBUG output to a file** (it's verbose; never pipe straight to a terminal you'll have to scroll):

   ```sh
   opencode run --print-logs --log-level DEBUG --model <model> "<prompt>" > /tmp/opencode.log 2>&1
   ```

2. **Grep for API-level errors first** — these are the highest-signal failure mode and the most commonly missed cause:

   ```sh
   grep -E 'service=llm.*ERROR|statusCode|isRetryable' /tmp/opencode.log
   ```

3. **Decode common status codes**:
   - `statusCode: 429` → rate limit. Free models on `opencode.ai/zen` (`opencode/big-pickle`, `opencode/minimax-m2.5-free`) have per-account quotas that get burned through fast during failing test loops. Switch to a paid model (`opencode/minimax-m2.5`) or wait out the window.
   - `statusCode: 401` / `403` → auth. Missing `GH_TOKEN` for the Copilot CLI subprocess, missing OpenCode auth, or wrong OIDC scope.
   - `isRetryable: true` repeating in the log → upstream provider issue. opencode is silently retrying; the test will eventually time out without surfacing the cause.

4. **If no API errors surface**, look at plugin/config loading next:

   ```sh
   grep -E 'plugin.*ERROR|config.*ERROR' /tmp/opencode.log
   ```

5. **For tool-calling investigations**, trace the interaction timing:

   ```sh
   grep -E 'session\.(prompt|message)|tool_use|tool_result' /tmp/opencode.log
   ```

**Important**: don't leave `--print-logs --log-level DEBUG` enabled inside test commands without bumping `spawnSync`'s `maxBuffer` to ~50 MB. The default 1 MB buffer overflows under DEBUG logging and the OS kills the process with `ENOBUFS`/`SIGTERM`. Capture-to-file via shell redirect is the safe default; in-process buffering is the trap. See the sibling learning [Reliable integration testing for OpenCode plugins](../best-practices/reliable-cli-integration-testing-2026-04-26.md).

## Why This Matters

opencode produces detailed structured logs precisely so you don't have to reverse-engineer behavior from black-box symptoms. Skipping that and theorizing first wastes hours and tokens — the rebuild that produced this learning involved roughly six hours of work chasing isolation bugs, plugin-loading hangs, and `OPENCODE_DISABLE_MODELS_FETCH` theories before someone ran the same prompt with `--print-logs --log-level DEBUG` and saw `HTTP 429: Rate limit exceeded` in the second line of output. API and auth errors should be ruled out before any isolation, plugin, or runtime hypothesis — they're cheaper to check, more likely to be the cause, and the runtime tells you about them directly if you ask.

## When to Apply

- Any opencode test timeout or hang exceeding the framework's limit.
- "build · <model>" processes stalling without progress or output.
- Empty `assistant[]` messages returned from `session.prompt`.
- Suspected tool-calling regression, plugin-loading bug, or test isolation problem.
- Anytime you're tempted to form a theory before reading logs.

## Examples

### Diagnostic command

```sh
opencode run --print-logs --log-level DEBUG --model opencode/big-pickle "PING" > /tmp/opencode.log 2>&1
grep -E 'service=llm.*ERROR|statusCode|isRetryable' /tmp/opencode.log
```

### Real log excerpt revealing rate limit

```
service=llm ERROR  HTTP 429: Rate limit exceeded
url=https://opencode.ai/zen/v1/messages
statusCode=429
isRetryable=true
```

This was the actual cause behind ~6 hours of misdirected investigation into upstream regressions. One grep would have found it immediately.

### Counterexample with paid model

Same prompt, paid model:

```sh
opencode run --print-logs --log-level DEBUG --model opencode/minimax-m2.5 "PING" > /tmp/opencode.log 2>&1
grep -E 'service=llm.*ERROR|statusCode|isRetryable' /tmp/opencode.log
# (no matches — clean run)

tail -1 /tmp/opencode.log
# PONG
```

### Counterexample with auth error

```
service=llm ERROR  HTTP 401: Unauthorized
url=https://api.githubcopilot.com/...
statusCode=401
isRetryable=false
```

`isRetryable: false` here means opencode surfaces the failure quickly rather than hanging — but unless `--print-logs` is on, the test framework will report `exit code 1` with no other context. The grep finds the cause in the first line.

## Related

- Sibling learning: [Reliable integration testing for OpenCode plugins via CLI invocations](../best-practices/reliable-cli-integration-testing-2026-04-26.md) — the integration-test rebuild that this diagnostic recipe enabled, including the `spawnSync`/`maxBuffer` interaction with `--print-logs`.
- opencode CLI reference: https://opencode.ai/docs/cli/ (`--print-logs`, `--log-level` flags).
