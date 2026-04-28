---
title: Bounded-Concurrency Worker Pool via Chunked Promise.all
date: 2026-04-28
category: best-practices
module: concurrency_control
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Implementing bounded parallel processing
  - Processing lists with concurrent tasks
  - Trading simplicity for head-of-line blocking
  - When individual tasks have bounded latency
tags:
  - bounded-concurrency
  - promise-all
  - chunking
  - worker-pool
  - parallel-processing
  - head-of-line-blocking
---

# Bounded-Concurrency Worker Pool via Chunked Promise.all

## Context

Bounded concurrency is useful when you have a batch of independent async tasks, you want more throughput than a plain `for` loop, but a full worker-pool abstraction would be gratuitous. In this repo, `processEntries` in `src/runtime/orphan-reaper.ts` runs a small one-shot batch during plugin init, and each probe has an explicit 1-second ceiling via `psField` (`src/runtime/orphan-reaper.ts:29-38`). That bounded per-task latency is what makes a chunked `Promise.all` pattern viable here: the worst-case stall per chunk is known up front.

## Guidance

Use a fixed chunk size, slice the input into waves, and `await Promise.all(chunk.map(...))` for each wave. That gives you "at most K entries in flight" with no dependency, semaphore, queue, or token bucket.

In the shipped code, the cap is currently an inline literal `5` in `src/runtime/orphan-reaper.ts:99-100`, not a named `MAX_CONCURRENT_PROBES` constant. The learning still holds: make the cap explicit, keep it small, and treat it as a deliberate latency-vs-simplicity tradeoff, not a magic number.

`5` is a reasonable choice here because it cuts a 10-entry file from roughly 10 sequential waves to 2 waves, while keeping the implementation tiny. The cost is explicit head-of-line blocking: chunk `N+1` cannot start until the slowest task in chunk `N` finishes.

One nuance from the real code: the cap is on **entries**, not individual `ps` children. Each entry then fans out into `getPidComm` and `getPidStartTime` concurrently (`src/runtime/orphan-reaper.ts:109-112`), so a 5-entry chunk can mean up to **10 concurrent `ps` subprocesses**. The current concurrency test only tracks `getPidComm`, so it proves the entry-wave shape, not total subprocess concurrency (`tests/orphan-reaper.test.ts:311-343`).

Actual timeout bound:

```ts
// src/runtime/orphan-reaper.ts:29-38
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

Actual chunked loop:

```ts
// src/runtime/orphan-reaper.ts:99-125
for (let i = 0; i < entries.length; i += 5) {
  const chunk = entries.slice(i, i + 5)
  const results = await Promise.all(
    chunk.map(async (entry) => {
      try {
        process.kill(entry.pid, 0)
      } catch {
        return { reaped: false, skipped: true }
      }

      const [liveComm, liveLstart] = await Promise.all([
        getPidComm(entry.pid),
        getPidStartTime(entry.pid),
      ])

      if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
        return { reaped: false, skipped: true }
      }
```

Actual concurrency-cap test:

```ts
// tests/orphan-reaper.test.ts:311-343
it('should cap concurrent getPidComm invocations at 5 for 10 entries', async () => {
  let maxConcurrent = 0
  let currentConcurrent = 0

  const res = await reapOrphans({
    // ...
    getPidComm: async () => {
      currentConcurrent++
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
      await new Promise((r) => setTimeout(r, 30))
      currentConcurrent--
      return 'copilot'
    },
```

If you present this pattern as guidance, be explicit about the head-of-line property:

- wave 1 starts up to 5 entries
- fast entries in wave 1 still wait for the slowest sibling
- wave 2 does not start until `Promise.all(wave1)` resolves

That is not a bug. It is the cost you are accepting in exchange for radical simplicity.

## Why This Matters

This pattern sits in the useful middle ground between "totally sequential" and "build a real worker pool." Here, that middle ground is justified because the work runs once at plugin init, each probe has a hard 1-second timeout (`src/runtime/orphan-reaper.ts:35-38`), and each file contains at most 10 entries, so even the chunked worst case is still within a soft startup budget. On a hot path, or anywhere tail latency matters, the same head-of-line blocking would be the wrong trade.

Documenting that tradeoff matters because the current implementation is intentionally the pragmatic minimum, not the universally best concurrency pattern. Future contributors should feel free to upgrade it to a streaming pool if the batch size grows, the timeout bound disappears, or init latency starts mattering more; that is exactly the kind of follow-up tracked by issue #49.

## When to Apply

- One-shot batches with bounded per-task latency, especially when each task has an explicit timeout.
- Small to moderate batches, roughly `<= 20` tasks.
- Cold paths such as init, setup, startup cleanup, or periodic maintenance.
- Situations where adding `p-limit`/`p-map` or writing a reusable pool would be more code than value.

## When NOT to Apply

- Hot paths where tail latency matters and one slow sibling should not delay the next ready task.
- Tasks with unbounded or poorly bounded latency.
- Large batches (`> 20-50` tasks) where per-wave blocking compounds into visible delay.

## Examples

### 1) Sequential baseline — simplest, but worst tail time

This is the obvious baseline: do each entry one at a time. It is easy to reason about, but with a 1-second timeout per entry and 10 entries, the batch can stretch to roughly 10 seconds.

```ts
// illustrative sequential version, not the shipped code
for (const entry of entries) {
  try {
    process.kill(entry.pid, 0)
  } catch {
    skipped++
    continue
  }

  const [liveComm, liveLstart] = await Promise.all([
    getPidComm(entry.pid),
    getPidStartTime(entry.pid),
  ])

  if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
    skipped++
    continue
  }

  try {
    await killProcessTree(entry.pid)
    reaped++
  } catch {
    skipped++
  }
}
```

Use this when the batch is tiny or clarity matters more than total wall time.

### 2) Current repo pattern — chunked waves of 5

This is the actual shipped approach in `src/runtime/orphan-reaper.ts:99-125`. It processes 10 entries in two waves of 5, so with bounded 1-second probes the batch is roughly `2 * timeout` in the "one slow entry per wave" shape.

```ts
// src/runtime/orphan-reaper.ts:99-125
for (let i = 0; i < entries.length; i += 5) {
  const chunk = entries.slice(i, i + 5)
  const results = await Promise.all(
    chunk.map(async (entry) => {
      try {
        process.kill(entry.pid, 0)
      } catch {
        return { reaped: false, skipped: true }
      }

      const [liveComm, liveLstart] = await Promise.all([
        getPidComm(entry.pid),
        getPidStartTime(entry.pid),
      ])

      if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
        return { reaped: false, skipped: true }
      }

      try {
        await killProcessTree(entry.pid)
        return { reaped: true, skipped: false }
      } catch {
        return { reaped: false, skipped: true }
      }
    }),
  )

  for (const r of results) {
    if (r.reaped) reaped++
    else if (r.skipped) skipped++
  }
}
```

Why this is fine here:

- bounded per-task timeout: `psField(..., 1000ms)` in `src/runtime/orphan-reaper.ts:35-38`
- cold path: orphan cleanup during plugin init
- small batch: up to 10 entries per file
- tiny implementation surface

Why it is not ideal:

- chunk `2` waits for the slowest task in chunk `1`
- the literal `5` is currently inline, so the cap is implicit rather than named
- real subprocess fan-out is higher than the test suggests because each entry does two probe calls in parallel

### 3) Streaming worker pool sketch — better tail behavior, more machinery

A streaming pool keeps `K` tasks in flight and starts the next task as soon as any slot frees up. For the same "two slow entries total, everything else fast" distribution that makes chunked-of-5 take about 2 seconds, a streaming pool of 5 can overlap both slow entries and finish in about 1 second.

```ts
// illustrative streaming pool sketch, not the shipped code
const queue = [...entries]
const workers = Array.from({ length: 5 }, async () => {
  while (queue.length > 0) {
    const entry = queue.shift()
    if (!entry) return

    try {
      process.kill(entry.pid, 0)
    } catch {
      skipped++
      continue
    }

    const [liveComm, liveLstart] = await Promise.all([
      getPidComm(entry.pid),
      getPidStartTime(entry.pid),
    ])

    if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
      skipped++
      continue
    }

    try {
      await killProcessTree(entry.pid)
      reaped++
    } catch {
      skipped++
    }
  }
})

await Promise.all(workers)
```

This is the better pattern when:

- tail latency matters
- task runtimes vary a lot
- the batch is larger
- you want the queue to keep draining as soon as a fast task finishes

But it is also more moving parts, more shared-state care, and more code than the repo currently needs.

### Timing summary

- **Sequential**: roughly `10 * 1s = 10s` worst case for 10 1-second entries.
- **Chunked-of-5**: roughly `2 * 1s = 2s` when one slow entry lands in each wave.
- **Streaming pool of 5**: roughly `1s` for that same two-slow-entry distribution, because both slow tasks can overlap across worker slots.

That last number is **not** a universal worst-case bound. If all 10 entries hit the 1-second ceiling, a 5-worker streaming pool is still roughly 2 seconds. The win is eliminating artificial wave boundaries, not breaking the math of bounded concurrency.

## Related

- See [Per-instance PID files with spawner-liveness gating](per-instance-pid-files-spawner-liveness-gating-2026-04-28.md) for the consumer of this concurrency pattern (reap-time per-PID identity probes).
- See [Secure process introspection with array-spawn ps and comm-field identity gate](secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md) for the per-task work that runs inside each chunk.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49) (streaming worker pool replacement, configurable concurrency cap)
