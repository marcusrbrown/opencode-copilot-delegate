---
title: Atomic File Append/Remove with O_EXCL Temp-File and In-Process Serialization Queue
date: 2026-04-28
category: best-practices
module: file_operations
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - Implementing atomic file mutations
  - Handling concurrent appends to shared files
  - Ensuring crash-safe PID file writes
  - Avoiding race conditions without locks
tags:
  - atomic-writes
  - file-serialization
  - temp-files
  - o-excl
  - crash-safety
  - in-process-queue
---

# Atomic File Append/Remove with O_EXCL Temp-File and In-Process Serialization Queue

## Context

The orphan reaper needs a tiny durable ledger of child processes so cleanup can survive crashes and restarts. A naive "just append a line" implementation is fine until several spawn paths try to mutate the same PID file at nearly the same time, at which point you can get torn writes, lost updates, or truncated rewrites. `proper-lockfile` would solve a broader class of problems, but for a per-instance PID file owned by one process, that's heavier than the problem warrants.

This fix uses two cheaper guarantees together: atomic replace at the filesystem level, and per-file serialization at the application level. The result is a small dependency-free pattern that is easy to audit and hard to corrupt.

## Guidance

Use a per-target in-process queue to serialize all read-modify-write mutations, then make each mutation itself atomic by writing the full next file image to a unique temp file and `rename()`-ing it into place. In this repo, the queue is keyed by absolute file path in `writeChains`, and both append and remove operations run through the same helper (`src/runtime/pid-file.ts:15-30`).

```ts
// src/runtime/pid-file.ts:15-30
const writeChains = new Map<string, Promise<void>>()

async function serializeWrite(
  filePath: string,
  work: () => Promise<void>,
): Promise<void> {
  const prev = writeChains.get(filePath) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(work)
  writeChains.set(filePath, next)
  try {
    await next
  } finally {
    if (writeChains.get(filePath) === next) {
      writeChains.delete(filePath)
    }
  }
}
```

That cleanup check is the important invariant: only delete the map entry if the promise you just awaited is still the current tail for that path. Without that guard, one caller could finish and erase a newer chain entry created by another caller, reopening the race you were trying to close.

The append path is a straight read-modify-write. It reads the current file if present, appends one tab-delimited line, writes the entire new content to a random temp path opened with exclusive-create semantics, then atomically renames the temp file over the target (`src/runtime/pid-file.ts:44-77`).

```ts
// src/runtime/pid-file.ts:50-76
await serializeWrite(filePath, async () => {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })

  let existing = ''
  try {
    existing = await readFile(filePath, 'utf-8')
  } catch (e) {
    if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
  }

  const line = `${pid}\t${comm}\t${lstart}\n`
  const content = existing + line
  const tempPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`
  const fd = await open(
    tempPath,
    fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
    0o600,
  )
  // ...
  await rename(tempPath, filePath)
  await chmod(filePath, 0o600)
})
```

The remove path uses the exact same structure: read the whole file, filter out the matching PID line, write the replacement image to a unique temp file, rename over the original, and delete the file entirely if it becomes empty (`src/runtime/pid-file.ts:80-120`).

```ts
// src/runtime/pid-file.ts:84-119
await serializeWrite(filePath, async () => {
  let existing = ''
  try {
    existing = await readFile(filePath, 'utf-8')
  } catch (e) {
    if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
    return
  }

  const prefix = `${pid}\t`
  const lines = existing.split('\n')
  const filtered = lines.filter((line) => !line.startsWith(prefix))
  if (filtered.length === lines.length) return

  const content = filtered.join('\n')
  const tempPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`
  // ...
  await rename(tempPath, filePath)
  await chmod(filePath, 0o600)

  if (content.trim().length === 0) {
    await unlink(filePath)
  }
})
```

Per-instance keying is what makes the in-process queue sufficient here. The PID file path includes the current process ID, so each running plugin instance owns its own file instead of many processes contending on one shared ledger (`src/runtime/pid-file.ts:33-41`).

```ts
// src/runtime/pid-file.ts:33-41
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

The visible test coverage in this checkout validates the queue behavior directly by firing ten concurrent appends and asserting that the final file contains exactly ten well-formed entries with unique PIDs (`tests/pid-file.test.ts:179-211`). That is the application-level guarantee you care about: concurrent callers do not stomp each other's read step.

```ts
// tests/pid-file.test.ts:179-211
describe('concurrency', () => {
  it('should serialize 10 concurrent appends into exactly 10 entries', async () => {
    const triples = Array.from({ length: 10 }, (_, i) => ({
      pid: 1000 + i,
      comm: `proc-${i}`,
      lstart: `time-${i}`,
    }))

    await Promise.all(
      triples.map((t) => appendPidEntry(filePath, t.pid, t.comm, t.lstart)),
    )

    expect(lines).toHaveLength(10)
    expect(pids.size).toBe(10)
  })
})
```

> Note: `O_EXCL` lives in the `fs` constants namespace, not `os.constants`. In this implementation it is accessed as `fsConstants.O_EXCL` via the `node:fs/promises` constants export (`src/runtime/pid-file.ts:64-67`, `103-106`). `os.constants.O_EXCL` is the sharp edge here: it is not the right source, and code that composes flags from `os.constants` will quietly do the wrong thing.

> Source note: the current `tests/pid-file.test.ts` in this repo snapshot clearly covers concurrent-write determinism, but separate crash-mid-write or `EEXIST` tests are not present in that file. The crash and exclusive-create semantics below are therefore derived from the implementation itself, not quoted from missing test cases.

## Why This Matters

Naive direct append code fails in two ways once concurrency shows up: writes can interleave at byte boundaries, and any later remove operation forces a read-modify-write cycle that can drop updates if two callers read the same old content. Writing the full next state to a temp file and renaming it means readers either get the old complete file or the new complete file, never a half-written target. The in-process queue handles the other half of the problem by ordering the read step, so caller B cannot compute its new content from stale state while caller A is already mid-update.

`proper-lockfile` is overkill here because the scope is tiny: one small text file, one process owns it, and the cost of serializing in memory is near zero. The per-instance filename (`${process.pid}.pids`) removes cross-process contention by design, so there is no need to reach for fcntl-style coordination or a heavier dependency just to protect one process from itself.

## When to Apply

- Small line-delimited state files where the whole file is comfortably rewritten on each mutation.
- All writers are in the same process, or you otherwise know a single process owns a given target path.
- Correctness and crash safety matter more than raw append throughput.
- You want a boring solution with no native locking dependency and no extra package surface.

## When NOT to Apply

- Multiple processes can mutate the same file path. Use a real cross-process lock or move the state into sqlite/WAL.
- The file is append-heavy or large enough that full rewrite-on-each-mutation becomes a bottleneck.
- The target may live on filesystems where `rename()` atomicity or `O_EXCL` behavior is weak or inconsistent, such as some NFS/FUSE setups.

## Examples

### Before: naive direct append

A naive implementation treats each spawn event as "just append one line." That looks harmless until two writers overlap and the underlying writes are not observed as one indivisible record append.

```ts
// before: illustrative naive pattern
import { appendFile } from 'node:fs/promises'

async function recordSpawn(filePath: string, pid: number, comm: string, lstart: string) {
  const line = `${pid}\t${comm}\t${lstart}\n`
  await appendFile(filePath, line, 'utf8')
}

await Promise.all([
  recordSpawn(pidFile, 101, 'copilot', 'T1'),
  recordSpawn(pidFile, 102, 'copilot', 'T2'),
])
```

Possible corruption mode from overlapping appends:

```text
101\tcopi102\tcopilot\tT2
lot\tT1
```

Even if you dodge byte-level tearing, the minute you also need removal, you tend to graduate into naive concurrent read-modify-write:

```ts
// before: illustrative lost-update pattern
async function removePidNaive(filePath: string, pid: number) {
  const existing = await readFile(filePath, 'utf8')
  const next = existing
    .split('\n')
    .filter((line) => !line.startsWith(`${pid}\t`))
    .join('\n')
  await writeFile(filePath, next, 'utf8')
}
```

Now the failure mode is stale reads:

1. append A reads old file
2. append B reads same old file
3. append A writes `old + A`
4. append B writes `old + B`

Final state: A disappears.

### After: queued read-modify-write + atomic replace

The shipped pattern makes each mutation compute the next full file image in order, then publish that image atomically.

```ts
await Promise.all([
  appendPidEntry(pidFile, 101, 'copilot', 'T1'),
  appendPidEntry(pidFile, 102, 'copilot', 'T2'),
])
```

What happens instead:

1. caller A enters `serializeWrite(pidFile, ...)`
2. caller B chains behind A in `writeChains`
3. A reads current content, writes temp file, renames into place
4. B reads A's finished result, writes its own temp file, renames into place

Final file:

```text
101\tcopilot\tT1
102\tcopilot\tT2
```

No partial target file is ever published because `rename()` swaps in a completed temp file, and a crash before `rename()` leaves at worst an orphaned `*.tmp.<hex>` file. The repo's concurrency test captures the ordering guarantee in bulk by launching ten concurrent appends and asserting ten intact records, not a corrupted subset (`tests/pid-file.test.ts:179-211`).

## Related

- See [Per-instance PID files with spawner-liveness gating](per-instance-pid-files-spawner-liveness-gating-2026-04-28.md) for the file naming scheme that makes the in-process queue sufficient.
- See [Centralized terminal-state idempotency for task lifecycle](centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md) for the cleanup hook that triggers `removePidEntry` calls.
- Tracking issue: [#49 — v0.1.x / v0.2.x runtime hardening follow-ups](https://github.com/marcusrbrown/opencode-copilot-delegate/issues/49) (symlink hardening / `O_NOFOLLOW`, `chmod`-after-rename redundancy)
