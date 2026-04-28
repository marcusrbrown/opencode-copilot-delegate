---
title: Centralized Terminal-State Idempotency for Task Lifecycle
date: 2026-04-28
category: best-practices
module: task_management
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Managing task status transitions
  - Ensuring idempotent terminal state changes
  - Coupling task state with cleanup hooks
  - Avoiding duplicate status mutations
tags:
  - task-lifecycle
  - idempotency
  - status-management
  - terminal-states
  - cleanup-hooks
  - state-guards
---

# Centralized Terminal-State Idempotency for Task Lifecycle

## Context

PR #50 fixed a task-lifecycle race in `src/runtime/subprocess.ts`: the abort listener can synchronously mark a task as `cancelled`, then the subprocess `close` event lands a moment later and tries to rewrite the same task as `complete` or `failed`. Before the refactor, the protection lived in a fragile inline guard on the close path, while other terminal writes were still direct mutations, so the invariant depended on every future callsite remembering the same rule. This came out of code review as a classic "future contributors must remember X" smell.

## Guidance

Use one helper for terminal-state writes and make all terminal callsites go through it.

**Shipped helper signature and actual contract**

```ts
setStatus(
  task: { status: TaskStatus; pid: number },
  newStatus: TaskStatus,
  options?: { pidFilePath?: string },
): void
```

In the shipped code, the helper is **terminal-idempotent**: if the current status and next status are both terminal (`complete | failed | cancelled`), it returns early; otherwise it writes the new status. If `options.pidFilePath` is present and the new status is terminal, it also fires the PID-file cleanup hook so terminal cleanup cannot be forgotten.

**Helper implementation — `src/runtime/task-status.ts:18-30`**

```ts
export function setStatus(
  task: { status: TaskStatus; pid: number },
  newStatus: TaskStatus,
  options?: SetStatusOptions,
): void {
  if (isTerminal(task.status) && isTerminal(newStatus)) {
    return
  }

  task.status = newStatus

  if (options?.pidFilePath && isTerminal(newStatus)) {
    removePidEntry(options.pidFilePath, task.pid).catch(() => {})
  }
}
```

That gives you one place to enforce "first terminal write wins" across competing async handlers. It also couples terminal-state transition to PID-file cleanup, which is the right kind of coupling here: cleanup is part of finishing the task.

**Close path after the refactor — `src/runtime/subprocess.ts:59-70`**

```ts
function finalizeTask(
  task: SpawnCopilotResult,
  exitCode: number | null,
  stderrText: string,
  pidFilePath?: string,
): void {
  flushBufferedStdout(task)
  task.endedAt = Date.now()
  task.exitCode = exitCode ?? undefined

  setStatus(task, exitCode === 0 ? 'complete' : 'failed', { pidFilePath })
```

A useful nuance from the shipped code: the **`endedAt` invariant still lives on the close path**, not inside `setStatus`. So the centralization here is about terminal-status idempotency and cleanup; timestamping is still partially caller-owned. If you add more terminal paths later and they also need `endedAt`, either move that into the helper or make the caller stamp it explicitly.

**Abort path after the refactor — `src/runtime/subprocess.ts:146-154`**

```ts
task.abortController.signal.addEventListener(
  'abort',
  () => {
    if (task.status !== 'running') {
      return
    }

    setStatus(task, 'cancelled', { pidFilePath: opts.pidFilePath })
    killProcessTree(task.pid).catch(() => {
```

**Spawn-error path after the refactor — `src/runtime/subprocess.ts:161-166`**

```ts
task.completionPromise = new Promise<void>((resolve) => {
  child.once('error', (error) => {
    setStatus(task, 'failed', { pidFilePath: opts.pidFilePath })
    task.errorText = stripAnsi(error.message)
    resolve()
  })
```

The tests pin the behavior that matters: once a task is already terminal, later terminal writes do nothing.

**No-op on cancelled → complete — `tests/task-status.test.ts:43-57`**

```ts
it('preserves cancelled when setStatus is called with complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
  tempPaths.push(dir)
  const pidFilePath = join(dir, 'orphans.pids')

  const task = makeTask('cancelled', 12345)
  await appendPidEntry(
    pidFilePath,
    task.pid,
    'bash',
    'Mon Apr 27 10:00:00 2026',
  )

  setStatus(task, 'complete', { pidFilePath })
  expect(task.status).toBe('cancelled')
```

**No-op on failed → cancelled — `tests/task-status.test.ts:64-68`**

```ts
it('preserves failed when setStatus is called with cancelled', () => {
  const task = makeTask('failed', 12345)

  setStatus(task, 'cancelled')
  expect(task.status).toBe('failed')
})
```

## Why This Matters

Inline lifecycle guards rot because they are a memory exercise, not a structural guarantee. The fourth async path — timeout, watchdog, retry abort, orphan reaper, whatever — gets added months later by someone who did not internalize why the original guard existed, and the race quietly comes back. A helper like `setStatus` turns the rule into an API boundary: callsites become boring, and the invariant stops relying on discipline. Coupling PID cleanup to that same helper is cheaper than teaching every future caller to remember two things at once: "don't clobber terminal state" and "also remove the orphan PID entry."

## When to Apply

- Any scattered event-driven lifecycle where multiple handlers can race to finish the same task: `close`, `abort`, `error`, `timeout`, watchdog, retry cancellation.
- Any place where terminal transition has cleanup that must happen exactly once or at least must not be forgotten.
- Any workflow where the desired rule is effectively **first terminal writer wins**, not **last writer wins**.

## When NOT to Apply

- When the state model has many legal transitions with different rules per edge; use an explicit FSM or transition table instead of a single coarse helper.
- When cleanup is intentionally repeatable and harmless, and duplicate execution is acceptable.
- When you need stronger semantics than the shipped helper currently provides; this helper prevents terminal-over-terminal clobbering, but it is not a full "no transitions away from terminal" state machine.

## Examples

**Before: the invariant was split across callsites.**
Only the close path carried a guard, and the other terminal paths still mutated `task.status` directly.

**Pre-PR close path — `src/runtime/subprocess.ts:53-60` (parent of `e2ea508`)**

```ts
): void {
  flushBufferedStdout(task)
  task.endedAt = Date.now()
  task.exitCode = exitCode ?? undefined

  if (task.status !== 'cancelled') {
    task.status = exitCode === 0 ? 'complete' : 'failed'
  }
```

**Pre-PR abort path — `src/runtime/subprocess.ts:136-145` (parent of `e2ea508`)**

```ts
task.abortController.signal.addEventListener(
  'abort',
  () => {
    if (task.status !== 'running') {
      return
    }

    task.status = 'cancelled'
    killProcessTree(task.pid).catch(() => {
```

**Pre-PR spawn-error path — `src/runtime/subprocess.ts:151-154` (parent of `e2ea508`)**

```ts
task.completionPromise = new Promise<void>((resolve) => {
  child.once('error', (error) => {
    task.status = 'failed'
    task.errorText = stripAnsi(error.message)
```

That layout is brittle: one callsite remembered the guard, two did not, and a fourth one could easily have repeated the mistake.

**After: every terminal path delegates to the same helper.**

**Close path — `src/runtime/subprocess.ts:65-70`**

```ts
  flushBufferedStdout(task)
  task.endedAt = Date.now()
  task.exitCode = exitCode ?? undefined

  setStatus(task, exitCode === 0 ? 'complete' : 'failed', { pidFilePath })
```

**Abort path — `src/runtime/subprocess.ts:149-154`**

```ts
    if (task.status !== 'running') {
      return
    }

    setStatus(task, 'cancelled', { pidFilePath: opts.pidFilePath })
    killProcessTree(task.pid).catch(() => {
```

**Spawn-error path — `src/runtime/subprocess.ts:162-164`**

```ts
  child.once('error', (error) => {
    setStatus(task, 'failed', { pidFilePath: opts.pidFilePath })
    task.errorText = stripAnsi(error.message)
```

**Hypothetical fourth callsite**

Old pattern, easy to get wrong:

```ts
child.once('timeout', () => {
  task.status = 'failed'
})
```

That silently skips both the terminal-idempotency rule and PID cleanup.

New pattern, hard to get wrong:

```ts
child.once('timeout', () => {
  setStatus(task, 'failed', { pidFilePath: opts.pidFilePath })
})
```

The timeout path now inherits the same terminal-write behavior as `close`, `abort`, and `error` without the contributor having to remember any repo-specific folklore.

## Related

- See [Per-instance PID files with spawner-liveness gating](per-instance-pid-files-spawner-liveness-gating-2026-04-28.md) for the cleanup hook that this helper invokes on terminal transitions.
- See [Atomic file append/remove with O_EXCL temp-file and in-process serialization queue](atomic-file-append-remove-o-excl-temp-file-2026-04-28.md) for the underlying `removePidEntry` mechanism.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49) (maintainability cleanups in `task-status.ts`)
