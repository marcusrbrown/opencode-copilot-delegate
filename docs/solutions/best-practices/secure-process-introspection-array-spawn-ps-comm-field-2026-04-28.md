---
title: Secure Process Introspection with Array-Spawn ps and Comm-Field Identity Gate
date: 2026-04-28
category: best-practices
module: process_introspection
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Verifying process ownership securely
  - Preventing PID reuse and tampering
  - Using kernel-tracked process identity
  - Safely spawning system commands
tags:
  - process-introspection
  - ps-command
  - comm-field
  - lstart-matching
  - secure-spawning
  - injection-prevention
  - kernel-truth
---

# Secure Process Introspection with Array-Spawn ps and Comm-Field Identity Gate

## Context

In a long-lived plugin, watchdog, or reaper, "I still have PID 1234, so it's safe to kill" is a bad assumption. PIDs get reused, so a stale pidfile can point at a completely unrelated process by the time cleanup runs. Matching `argv` is not enough either, because `args` is just process command-line presentation state and is much easier to spoof or mislead than a kernel-reported identity signal.

In `src/runtime/orphan-reaper.ts`, the shipped fix closes both gaps: it re-reads the live process identity immediately before `killProcessTree`, and only proceeds when both `comm` and `lstart` still match the values captured at spawn time (`src/runtime/orphan-reaper.ts:109-115`). That combination defends against both stale PID reuse and "same PID, believable-looking argv" mistakes.

## Guidance

Use a two-part identity gate before signaling any PID you are recovering from persisted state:

- **Never shell-string `ps`.** Spawn `ps` with an argv array so the OS passes discrete arguments directly to the process. That removes shell parsing from the equation and avoids command injection footguns.
- **Use `comm`, not `args`, for the name check.** `comm` is a kernel-reported process/task name field, which is a materially stronger signal than `args` because it is not just the user-facing command-line string.
- **Use `lstart` as the second identity leg.** A reused PID running the same binary can still pass a `comm` check. Matching start time closes that hole.
- **Require both fields to match.** `comm` alone is insufficient; `lstart` alone is insufficient; both together are the gate.
- **Treat introspection failure as "do not kill."** If `ps` times out, errors, exits non-zero, or returns empty output, collapse that to "identity unverifiable" and skip the signal.
- **Drain `stderr`.** If you never read `stderr`, the child can block on a full pipe buffer under backpressure and hang the caller even though the command itself is trivial.

The core wrapper is small and boring, which is exactly what you want in a safety check:

```ts
function psField(pid: number, field: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', `${field}=`])
    let stdout = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 1000)
```

— `src/runtime/orphan-reaper.ts:29-38`

That first excerpt is the important spawn pattern: no shell, no string interpolation into a shell command, and a bounded timeout so introspection cannot wedge startup or cleanup forever.

The second detail is easy to miss and worth preserving as part of the pattern, not a throwaway implementation note:

```ts
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    // Drain stderr so the OS pipe buffer never fills under backpressure.
    // An unread stderr pipe on a long-running or backlogged ps invocation
    // can stall the subprocess, blocking plugin init.
    child.stderr?.resume()
```

— `src/runtime/orphan-reaper.ts:40-46`

If a subprocess writes to `stderr` and the parent never drains it, the kernel pipe can fill. Once full, the child blocks on write, which means it may never exit, which means your seemingly harmless introspection helper can hang the system in exactly the path that is supposed to make cleanup safer.

The wrapper also normalizes failure to a safe default:

```ts
    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || code !== 0) {
        resolve(null)
      } else {
        const trimmed = stdout.trim()
        resolve(trimmed || null)
      }
    })

    child.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })
```

— `src/runtime/orphan-reaper.ts:48-60`

In the current implementation, timeout, spawn error, non-zero exit, and empty output all become `null`. That is fine here because the caller only needs one answer: "can I still prove this is the same process?" If not, skip the kill.

The actual identity gate is the real win:

```ts
const [liveComm, liveLstart] = await Promise.all([
  getPidComm(entry.pid),
  getPidStartTime(entry.pid),
])

if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
  return { reaped: false, skipped: true }
}
```

— `src/runtime/orphan-reaper.ts:109-115`

That `||` is the contract. If either leg of identity moved, the process is no longer trusted. No "close enough," no partial match, no best-effort kill.

A clean way to describe the pattern is:

1. Record `pid`, `comm`, and `lstart` when you spawn or first adopt the child.
2. When it is time to reap, re-read live `comm` and `lstart` with array-spawned `ps`.
3. If either value differs, treat the PID as stale and skip signaling.
4. Only call `kill`/`SIGTERM`/`killProcessTree` after both values match.

That is the minimal, auditable version. No new dependencies, no process-table caching, no heroic heuristics.

## Why This Matters

Unverified kill paths are one of those bugs that stay invisible until they ruin someone's day. A stale PID can just as easily belong to a user's editor, terminal multiplexer, local database, or some other unrelated service as it can to the process you meant to reap. The blast radius is effectively unbounded because "wrong process" has no natural ceiling.

The cost of getting this right is tiny: two `ps` lookups and one equality check. The cost of getting it wrong can be data loss, corrupted local state, broken sessions, or maddening "why did your plugin kill my stuff?" reports that are hard to reproduce. This is cheap insurance in exactly the code path where safety matters more than micro-optimization.

## When to Apply

- Process supervisors, watchdogs, orphan reapers, daemon managers, plugin cleanup code, or background-task registries.
- Any code path that will signal or kill a PID loaded from disk, memory cache, or another process rather than from a still-live `ChildProcess` handle.
- Long-lived runtimes where PID reuse is plausible: developer machines, CI workers, agents, plugin hosts, or services with restart churn.
- Recovery code that runs after parent crashes, restarts, or partial state loss.
- "Kill the old worker before starting the new one" flows where stale bookkeeping can outlive the original process.

## When NOT to Apply

- You still hold the original `ChildProcess` handle from `spawn()` and never lose it; that handle already disambiguates the process identity better than a PID file.
- Single-shot scripts where the parent remains alive for the entire child lifetime and cleanup happens immediately.
- Fully controlled, closed process namespaces where you own the whole table and have consciously accepted a simpler risk model.
- Cases where you are not signaling an existing PID at all, but simply waiting on or disposing of a process object you already own directly.

## Examples

**Naive version: stale PID, wrong victim**

```ts
// recorded yesterday in a pidfile
const recordedPid = 1234

// Today, PID 1234 belongs to something else.
process.kill(recordedPid, 'SIGTERM')
```

Failure mode:

1. Worker A had PID `1234`.
2. Worker A exited.
3. The OS recycled PID `1234`.
4. Some unrelated process B now owns `1234`.
5. Your cleanup logic kills B.

That bug does not care whether B is harmless or critical.

**Safer version: verify identity before kill**

```ts
async function verifyIdentity(
  pid: number,
  expectedComm: string,
  expectedLstart: string,
): Promise<boolean> {
  const [liveComm, liveLstart] = await Promise.all([
    getPidComm(pid),
    getPidStartTime(pid),
  ])

  return liveComm === expectedComm && liveLstart === expectedLstart
}

if (await verifyIdentity(recordedPid, recordedComm, recordedLstart)) {
  await killProcessTree(recordedPid)
}
```

Now the reused PID does not pass unless it is still the same process instance.

**Why `comm` + `lstart`, not just `comm`**

```ts
// Still unsafe: a reused PID running the same binary can match this.
if ((await getPidComm(recordedPid)) === recordedComm) {
  await killProcessTree(recordedPid)
}
```

Failure mode:

1. Old process was `copilot`, PID `1234`.
2. Old process exited.
3. New, unrelated `copilot` process starts and receives PID `1234`.
4. `comm` still matches.
5. You kill the wrong `copilot` instance.

Adding `lstart` distinguishes the old instance from the new one.

**Shell-string `ps`: avoid this**

```ts
import { exec } from 'node:child_process'

exec(`ps -p ${pid} -o comm=`, (err, stdout) => {
  // ...
})
```

Problems:

- Shell parsing is back in play.
- Variable interpolation becomes part of a command string.
- Even if `pid` is "supposed to be numeric," this is an unnecessary footgun.

**Array-spawn `ps`: do this**

```ts
import { spawn } from 'node:child_process'

const child = spawn('ps', ['-p', String(pid), '-o', 'comm='])
```

Benefits:

- No shell.
- No quoting games.
- Arguments are passed as discrete argv tokens.
- Easier to reason about, test, and audit.

**Practical wrapper shape**

```ts
async function getPidField(pid: number, field: 'comm' | 'lstart') {
  const child = spawn('ps', ['-p', String(pid), '-o', `${field}=`])
  child.stderr?.resume()
  // collect stdout, enforce timeout, return trimmed value or null
}
```

That is the boring core. The safety comes from combining it with "skip kill unless both live values still match the recorded values."

## Related

- See [Per-instance PID files with spawner-liveness gating](per-instance-pid-files-spawner-liveness-gating-2026-04-28.md) for the broader orphan-reaper context that consumes this identity gate.
- See [Bounded-concurrency worker pool via chunked Promise.all](bounded-concurrency-worker-pool-chunked-promise-all-2026-04-28.md) for the parallelization strategy that runs these `ps` lookups.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49) (combined `ps -p <pid> -o comm=,lstart=` query, configurable timeout, missing test coverage for `psField` failure branches)
