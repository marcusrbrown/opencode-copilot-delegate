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

Bounded concurrency is useful when you have a batch of independent async tasks, you want more throughput than a plain `for` loop, but a full worker-pool abstraction would be gratuitous. The orphan reaper in `src/runtime/orphan-reaper.ts` shipped this pattern in v0.1.1 (chunked-of-5 with `Promise.all`) and then moved to a streaming worker pool in the v0.1.1 → next-release work because the head-of-line blocking property became visible under loaded conditions. Both patterns are documented here: chunked is the simpler tradeoff when per-task latency is bounded and uniform; streaming is the right pick when one slow task should not delay the next ready task.

## Guidance

Use a fixed chunk size, slice the input into waves, and `await Promise.all(chunk.map(...))` for each wave. That gives you "at most K entries in flight" with no dependency, semaphore, queue, or token bucket.

Make the cap explicit, keep it small, and treat it as a deliberate latency-vs-simplicity tradeoff, not a magic number. The orphan reaper now extracts `MAX_CONCURRENT_PROBES = 5` as a named top-level constant alongside the streaming pool implementation.

`5` is a reasonable choice for orphan-reap workloads because it cuts a 10-entry file from roughly 10 sequential waves to 2 waves, while keeping the implementation tiny. The cost is explicit head-of-line blocking: chunk `N+1` cannot start until the slowest task in chunk `N` finishes.

One nuance worth preserving from the v0.1.1 implementation: the cap was on **entries**, not individual `ps` children. Each entry fanned out into `getPidComm` and `getPidStartTime` concurrently, so a 5-entry chunk could mean up to **10 concurrent `ps` subprocesses**. The next-release work consolidates those two calls into a single `getPidIdentity(pid)` invocation that returns `{ comm, lstart }` from one `ps -p <pid> -o comm=,lstart=` call, halving the fork/exec cost and making the concurrency-cap math match reality (5 workers ⇒ at most 5 concurrent `ps` subprocesses).

Timeout bound (still applies in the streaming pool):

```ts
function runPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', args)
    let stdout = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 1000)
```

The v0.1.1 chunked loop (since replaced):

```ts
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

If you present the chunked pattern as guidance, be explicit about the head-of-line property:

- wave 1 starts up to 5 entries
- fast entries in wave 1 still wait for the slowest sibling
- wave 2 does not start until `Promise.all(wave1)` resolves

That is not a bug. It is the cost you are accepting in exchange for radical simplicity.

## Why This Matters

Chunked `Promise.all` sits in the useful middle ground between "totally sequential" and "build a real worker pool." It was justified for v0.1.1 because the work runs once at plugin init, each probe has a hard 1-second timeout, and each file contains at most 10 entries, so even the chunked worst case is still within a soft startup budget.

The move to a streaming worker pool came from a real observation: under loaded conditions a single slow `ps` invocation (occasionally 100s of milliseconds) blocks four sibling probes idly until the slow one returns, which can blow that soft init budget by 5–10x. A streaming pool keeps the same `MAX_CONCURRENT_PROBES = 5` cap without that blocking.

The chunked pattern is still the right choice when per-task latency is genuinely bounded and uniform, when the batch is tiny, or when reading the code without context is more important than tail-latency tuning. The decision is a tradeoff between simplicity and tail-latency behavior, not a one-way upgrade.

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

### 2) Chunked waves of 5 — the v0.1.1 shipped pattern (since replaced)

This was the v0.1.1 approach. It processes 10 entries in two waves of 5, so with bounded 1-second probes the batch is roughly `2 * timeout` in the "one slow entry per wave" shape.

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

Why chunked was fine for v0.1.1:

- bounded per-task timeout (1s SIGTERM ceiling)
- cold path: orphan cleanup during plugin init
- small batch: up to 10 entries per file
- tiny implementation surface

Why chunked stopped being the right tradeoff:

- chunk `N+1` waits for the slowest task in chunk `N`
- one slow `ps` (300-500ms is realistic on loaded systems) idles four sibling workers
- batch wall time becomes `chunk_count * slowest_in_each_chunk`, which dominates init under load

### 3) Streaming worker pool — the now-shipped pattern

A streaming pool spawns up to `K` workers that drain a shared queue independently. A slow probe blocks only its own worker; the others keep making progress. For the same "one slow entry, rest fast" distribution that takes the chunked pattern about 2 seconds, a streaming pool of 5 finishes in about 1 second, because the 9 fast probes don't have to wait for chunk-boundary synchronization.

```ts
const queue = [...entries]
const workerCount = Math.min(MAX_CONCURRENT_PROBES, entries.length)
const workers = Array.from({ length: workerCount }, async () => {
  while (true) {
    const entry = queue.shift()
    if (!entry) return
    const result = await processEntry(entry, killProcessTree, getPidIdentity)
    if (result.reaped) reaped++
    else if (result.skipped) skipped++
  }
})

await Promise.all(workers)
```

Key properties:

- `queue.shift()` is atomic in single-threaded JS — no race between the length check and the shift
- `reaped`/`skipped` increments are also atomic from the perspective of concurrent async functions; no yield happens between the `++` read and write
- a slow probe in worker `i` doesn't block workers `j ≠ i` from picking up new entries
- the cap stays at `MAX_CONCURRENT_PROBES = 5`, so concurrency math is unchanged

This is the better pattern when:

- tail latency matters
- task runtimes vary a lot
- the batch is larger
- you want the queue to keep draining as soon as a fast task finishes

### Timing summary

- **Sequential**: roughly `10 * 1s = 10s` worst case for 10 1-second entries.
- **Chunked-of-5**: roughly `2 * 1s = 2s` when one slow entry lands in each wave.
- **Streaming pool of 5**: roughly `1s` for that same two-slow-entry distribution, because both slow tasks can overlap across worker slots.

That last number is **not** a universal worst-case bound. If all 10 entries hit the 1-second ceiling, a 5-worker streaming pool is still roughly 2 seconds. The win is eliminating artificial wave boundaries, not breaking the math of bounded concurrency.

## Related

- See [Per-instance PID files with spawner-liveness gating](per-instance-pid-files-spawner-liveness-gating-2026-04-28.md) for the consumer of this concurrency pattern (reap-time per-PID identity probes).
- See [Secure process introspection with array-spawn ps and comm-field identity gate](secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md) for the per-task work that runs inside each chunk.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49) (streaming worker pool replacement, configurable concurrency cap)
