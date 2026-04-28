---
title: Per-Instance PID Files with Spawner-Liveness Gating
date: 2026-04-28
category: best-practices
module: subprocess_lifecycle
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Managing subprocess lifecycles in plugins
  - Preventing PID reuse of unrelated processes
  - Handling cross-instance orphan cleanup
  - Ensuring spawner liveness before reaping
tags:
  - pid-files
  - subprocess-management
  - liveness-probing
  - orphan-reaping
  - process-identity
  - comm-lstart-gate
---

# Per-Instance PID Files with Spawner-Liveness Gating

## Context

This plugin needed a way to clean up child Copilot CLI processes after OpenCode reloads the plugin or the host process crashes.
The original constraint was that OpenCode's `Hooks` interface had no dispose hook, so there was no reliable shutdown callback to do cleanup at unload time.
That forced cleanup to happen opportunistically at the next startup instead.
Once startup-time reap exists, the hard part is making it safe across concurrent OpenCode sessions and safe against PID reuse.

## Guidance

Use one orphan-tracking file per plugin host PID, not one shared file for the whole machine or repo.
The filename must be the host process PID because the reaper needs to ask a concrete OS question: "is the spawner that owns this file still alive?"
A logical session ID cannot answer that without an extra registry, while `process.pid` is directly probeable with `process.kill(pid, 0)`.

Excerpt (`src/runtime/pid-file.ts:33-42`):

```ts
export function resolveInstancePidFilePath(): string {
  const stateDir =
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(
    stateDir,
    'opencode-copilot-delegate',
    'orphans',
    `${process.pid}.pids`,
  )
}
```

That gives each running plugin instance its own file:

- `<XDG_STATE_HOME>/opencode-copilot-delegate/orphans/<plugin-pid>.pids`
- one host process, one file
- no cross-instance append/remove clobbering

Store child identity in each line as:

- `<pid>\t<comm>\t<lstart>`

`pid` alone is not enough.
A dead child PID can be reused by the kernel before the next startup.
`comm` helps ensure the process still has the same executable identity, and `lstart` defeats PID reuse by pinning the process start time.

Excerpt (`src/runtime/orphan-reaper.ts:73-77,109-115`):

```ts
interface PidEntry {
  pid: number
  comm: string
  lstart: string
}

// ...

const [liveComm, liveLstart] = await Promise.all([
  getPidComm(entry.pid),
  getPidStartTime(entry.pid),
])

if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
  return { reaped: false, skipped: true }
}
```

To obtain those identity fields at reap time, query `ps` directly.
The implementation asks for exactly the two fields it needs and treats timeout, spawn failure, or non-zero exit as "cannot verify," which safely downgrades to skip.

Excerpt (`src/runtime/orphan-reaper.ts:29-63`):

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

    // ...

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || code !== 0) {
        resolve(null)
      } else {
        const trimmed = stdout.trim()
        resolve(trimmed || null)
      }
    })
  })
}
```

Before opening a peer file, first ask whether the spawner named by the filename is still alive.
That is the spawner-liveness gate.
If the owning plugin process is still alive, skip the file entirely because that live instance still owns its children and its cleanup state.

Excerpt (`src/runtime/orphan-reaper.ts:20-27`):

```ts
export function defaultIsPluginAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return isErrnoException(e) && e.code === 'EPERM'
  }
}
```

On POSIX, `process.kill(pid, 0)` means:

- success: process exists and is signalable
- `EPERM`: process exists but you lack permission to signal it
- `ESRCH`: process does not exist

This implementation treats success and `EPERM` as "alive," and everything else as "not alive enough to trust ownership."
That is the right bias for reaping: never kill another still-running parent's children.

The per-file reap flow is:

1. list `orphans/`
2. ignore non-`.pids` files
3. parse the filename stem as the owning plugin PID
4. if the file belongs to another plugin instance and that plugin is alive, skip it
5. otherwise read entries from the file
6. for each entry, re-check `pid`, `comm`, and `lstart`
7. kill only when both identity fields still match
8. truncate the current instance's own file, or delete a dead peer's file

Excerpt (`src/runtime/orphan-reaper.ts:196-216`):

```ts
if (!isCurrent && isPluginAlive(filePid)) {
  return empty
}

const entries = await readPidFileEntries(filePath)
if (entries === null) {
  return empty
}

const { reaped, skipped } = await processEntries(
  entries,
  killProcessTree,
  getPidComm,
  getPidStartTime,
)
const deleted = await cleanupAfterReap(
  filePath,
  isCurrent,
  currentInstancePath,
)
```

Excerpt (`src/runtime/orphan-reaper.ts:248-279`):

```ts
for (const file of files) {
  if (!file.endsWith('.pids')) continue

  const filePath = join(pidFileDir, file)
  const stem = basename(file, extname(file))
  if (!/^[1-9]\d*$/.test(stem)) {
    console.warn(`[orphan-reaper] Skipping non-numeric PID file: ${file}`)
    continue
  }
  const filePid = Number(stem)

  const outcome = await reapOneFile(
    filePath,
    filePid,
    filePid === process.pid,
    currentInstancePath,
    isPluginAlive,
    killProcessTree,
    getPidComm,
    getPidStartTime,
  )

  reaped += outcome.reaped
  skipped += outcome.skipped
  if (outcome.scanned) scannedFiles++
  if (outcome.deleted) deletedFiles++
}
```

Run the reap at startup, before exposing tools, and never let reap failure block plugin initialization.
If the state directory is read-only, missing, or otherwise broken, the plugin should still come up and continue functioning.

Excerpt (`src/index.ts:31-48`):

```ts
const currentInstancePath = resolveInstancePidFilePath()
const pidFileDir = dirname(currentInstancePath)
try {
  await mkdir(pidFileDir, { recursive: true, mode: 0o700 })
  await reapOrphans({
    pidFileDir,
    currentInstancePath,
    killProcessTree,
    getPidComm,
    getPidStartTime,
  })
} catch {
  // mkdir or reap failure must not block plugin init.
}
```

A useful mental model is:

- filename answers "who owns this file?"
- `kill(pid, 0)` answers "is that owner still around?"
- `comm + lstart` answer "does this child PID still refer to the same process?"
- only after all three checks pass do you kill anything

The tests exercise the mixed-instance behavior directly: current file is processed, a dead foreign spawner file is processed and deleted, and a live foreign spawner file is skipped untouched (`tests/orphan-reaper.test.ts:78-133`).
That is the core safety property of the pattern.

## Why This Matters

A shared PID file lets concurrent plugin instances overwrite, truncate, or reap each other's state.
That creates the worst kind of startup bug: a fresh instance kills children that still belong to a different, healthy instance.
A blind kill based only on recorded PID is even worse because PID reuse can redirect cleanup toward an unrelated process.
Per-instance files remove clobber races, spawner-liveness probing preserves live ownership, and the `comm` + `lstart` gate closes the PID-reuse hole before any kill happens.

## When to Apply

- Anywhere a long-lived process spawns children whose lifecycle may outlive a parent crash, but should not survive a parent restart indefinitely.
- Plugin systems, supervisors, daemon-managed worker pools, and IDE/editor extensions that manage subprocesses such as language servers or external CLIs.
- Situations where multiple parent instances can run concurrently on the same machine and share a common state directory.
- Cases where startup-time recovery is the only reliable cleanup point.
- Do **not** use this when the framework already gives you a reliable dispose/shutdown hook; use the framework lifecycle directly instead.

## Examples

### Before: naive shared PID file

This version has two bugs:

1. all instances write to the same file
2. startup reaper trusts the stored child PID without checking whether the file's owner is still alive

```ts
const pidFile = join(stateDir, 'opencode-copilot-delegate', 'orphans.pids')

await appendFile(pidFile, `${child.pid}\n`)

for (const pid of await readPids(pidFile)) {
  await killProcessTree(pid)
}

await truncate(pidFile, 0)
```

Failure mode:

- OpenCode session A and session B both append to `orphans.pids`
- session B reloads first
- B reads the shared file and kills every recorded child PID
- A was still running, so B just killed A's active children
- if one recorded PID has been reused, B may kill an unrelated process

A session ID does not fix this if you use it as the filename:

```ts
const pidFile = join(stateDir, 'orphans', `${sessionId}.pids`)
```

That avoids one shared file, but now the filename cannot be used for liveness probing.
You still need some other mapping from `sessionId` to a live OS process, which is exactly the problem `process.pid` already solves.

### After: per-instance file + spawner-liveness gate

Each parent instance writes only to its own file:

```ts
const pidFile = join(
  stateDir,
  'opencode-copilot-delegate',
  'orphans',
  `${process.pid}.pids`,
)

await appendPidEntry(pidFile, child.pid, childComm, childStartTime)
```

At startup, only reap files whose owning parent is gone:

```ts
for (const file of await readdir(pidFileDir)) {
  const spawnerPid = Number(basename(file, '.pids'))

  if (spawnerPid !== process.pid && isPluginAlive(spawnerPid)) {
    continue
  }

  await reapEntriesFromDeadSpawner(join(pidFileDir, file))
}
```

That closes the cross-instance kill bug:

- session A owns `12345.pids`
- session B owns `23456.pids`
- B starts and scans the directory
- B probes `12345` with `kill(12345, 0)`
- if A is still alive, B skips `12345.pids` entirely
- only files for dead parents are eligible for reap

### Before: unverified child PID kill

This version avoids shared-file clobbering but still trusts stale child PIDs:

```ts
for (const { pid } of entries) {
  try {
    process.kill(pid, 0)
    await killProcessTree(pid)
  } catch {
    // already dead
  }
}
```

Failure mode:

- child PID `8123` was recorded yesterday
- that child died
- the kernel reused `8123` for another process
- `kill(8123, 0)` succeeds
- your reaper kills the wrong process tree

### After: identity-gated kill

Re-check both executable identity and start time before killing:

```ts
for (const entry of entries) {
  try {
    process.kill(entry.pid, 0)
  } catch {
    continue
  }

  const [liveComm, liveLstart] = await Promise.all([
    getPidComm(entry.pid),
    getPidStartTime(entry.pid),
  ])

  if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
    continue
  }

  await killProcessTree(entry.pid)
}
```

This closes the PID-reuse hole:

- `comm` rejects "same PID, different executable"
- `lstart` rejects "same PID, same executable name, different process lifetime"
- the kill only happens when the live process still matches the exact recorded child identity

### Real-source alignment

The shipped implementation follows that exact shape:

- per-instance file path keyed by `process.pid` (`src/runtime/pid-file.ts:33-42`)
- peer-file owner liveness gate via `defaultIsPluginAlive` (`src/runtime/orphan-reaper.ts:20-27`)
- `ps -p <pid> -o comm=` and `ps -p <pid> -o lstart=` for identity checks (`src/runtime/orphan-reaper.ts:29-63`)
- strict `comm` and `lstart` equality before `killProcessTree` (`src/runtime/orphan-reaper.ts:109-120`)
- startup-time directory scan and per-file reap (`src/runtime/orphan-reaper.ts:248-279`)
- startup reap wrapped so plugin init never fails closed (`src/index.ts:31-48`)

## Related

- See [Secure process introspection with array-spawn ps and comm-field identity gate](secure-process-introspection-array-spawn-ps-comm-field-2026-04-28.md) for the kernel-truth identity check that runs inside the reap loop.
- See [Centralized terminal-state idempotency for task lifecycle](centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md) for how PID-file cleanup is coupled to terminal status transitions in this codebase.
- See [Atomic file append/remove with O_EXCL temp-file and in-process serialization queue](atomic-file-append-remove-o-excl-temp-file-2026-04-28.md) for the per-instance PID file's mutation pattern.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49)
