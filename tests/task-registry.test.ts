import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createTask, deleteTask } from '../src/runtime/task-registry'
import { setStatus } from '../src/runtime/task-status'

const tempPaths: string[] = []

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    rmSync(p, { force: true, recursive: true })
  }
})

describe('task registry PID-file hooks', () => {
  it('appends to PID file on spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-registry-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const child = Bun.spawn({ cmd: ['sleep', '30'] })
    const abortController = new AbortController()

    const task = createTask(
      {
        parentSessionID: 'session-1',
        pid: child.pid,
        startedAt: Date.now(),
        status: 'running',
        args: ['-c', 'sleep 30'],
        cwd: process.cwd(),
        stdoutLineBuffer: '',
        events: [],
        child,
        completionPromise: child.exited.then(() => undefined),
        abortController,
        pidFilePath,
      },
      undefined,
    )

    await delay(200)

    const content = readFileSync(pidFilePath, 'utf-8')
    expect(content).toContain(`${child.pid}\t`)

    child.kill()
    deleteTask(task.taskId)
  })

  it('removes from PID file on terminal transition', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-registry-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const child = Bun.spawn({ cmd: ['sleep', '30'] })
    const abortController = new AbortController()

    const task = createTask(
      {
        parentSessionID: 'session-1',
        pid: child.pid,
        startedAt: Date.now(),
        status: 'running',
        args: ['-c', 'sleep 30'],
        cwd: process.cwd(),
        stdoutLineBuffer: '',
        events: [],
        child,
        completionPromise: child.exited.then(() => undefined),
        abortController,
        pidFilePath,
      },
      undefined,
    )

    await delay(200)
    expect(readFileSync(pidFilePath, 'utf-8')).toContain(`${child.pid}\t`)

    setStatus(task, 'cancelled', { pidFilePath })

    await delay(200)
    expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow()

    child.kill()
    deleteTask(task.taskId)
  })

  it('skips PID-file work when pid <= 0', async () => {
    // Given a task with pid === 0 (sentinel for "no subprocess yet").
    // The createTask guard `task.pid > 0 && pidFilePath` must short-circuit
    // before any getPidIdentity / appendPidEntry side effect.
    const dir = mkdtempSync(join(tmpdir(), 'task-registry-zero-pid-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const abortController = new AbortController()
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    try {
      const task = createTask(
        {
          parentSessionID: 'session-1',
          pid: 0,
          startedAt: Date.now(),
          status: 'running',
          args: [],
          cwd: process.cwd(),
          stdoutLineBuffer: '',
          events: [],
          // Only pid is read by the guard before short-circuit, so a
          // stand-in object is sufficient for the fixture.
          child: { pid: 0 } as unknown as ReturnType<typeof Bun.spawn>,
          completionPromise: Promise.resolve(),
          abortController,
          pidFilePath,
        },
        undefined,
      )

      await delay(200)

      // Neither the file nor a warning should exist — the guard skipped
      // the entire async block.
      expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow()
      expect(warnings).toHaveLength(0)

      deleteTask(task.taskId)
    } finally {
      console.warn = originalWarn
    }
  })

  it('skips PID-file work when pidFilePath is undefined', async () => {
    // Given a task with pid > 0 but no pidFilePath. The guard should
    // short-circuit on the second clause and never call getPidIdentity.
    const child = Bun.spawn({ cmd: ['sleep', '30'] })
    const abortController = new AbortController()

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    try {
      const task = createTask(
        {
          parentSessionID: 'session-1',
          pid: child.pid,
          startedAt: Date.now(),
          status: 'running',
          args: ['-c', 'sleep 30'],
          cwd: process.cwd(),
          stdoutLineBuffer: '',
          events: [],
          child,
          completionPromise: child.exited.then(() => undefined),
          abortController,
          // Intentionally no pidFilePath
        },
        undefined,
      )

      await delay(200)

      // The task is registered but no file work happened — no warnings
      // about ps lookups, no append attempts.
      expect(warnings).toHaveLength(0)

      child.kill()
      deleteTask(task.taskId)
    } finally {
      console.warn = originalWarn
    }
  })

  it('silently swallows appendPidEntry failures when pidFilePath parent is unwritable', async () => {
    // Regression test for the `.catch(() => {})` on the appendPidEntry call
    // chain. If appendPidEntry's serializeWrite chain throws (e.g., EACCES
    // when the parent directory is read-only), the failure must not
    // propagate to the caller and must not crash the registry.
    if (process.getuid?.() === 0) {
      // Root bypasses chmod permission checks; the EACCES never fires.
      return
    }

    const parent = mkdtempSync(join(tmpdir(), 'task-registry-readonly-'))
    tempPaths.push(parent)
    // Create the file path inside an unwritable directory; appendPidEntry's
    // mkdir(dirname, ...) will throw EACCES.
    const readonlyDir = join(parent, 'locked')
    mkdirSync(readonlyDir)
    chmodSync(readonlyDir, 0o500)
    const pidFilePath = join(readonlyDir, 'subdir', 'orphans.pids')

    const child = Bun.spawn({ cmd: ['sleep', '30'] })
    const abortController = new AbortController()

    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    try {
      // The append failure happens asynchronously inside the .then chain;
      // the test passes if no unhandled rejection escapes and createTask
      // returns normally.
      const task = createTask(
        {
          parentSessionID: 'session-1',
          pid: child.pid,
          startedAt: Date.now(),
          status: 'running',
          args: ['-c', 'sleep 30'],
          cwd: process.cwd(),
          stdoutLineBuffer: '',
          events: [],
          child,
          completionPromise: child.exited.then(() => undefined),
          abortController,
          pidFilePath,
        },
        undefined,
      )

      // Wait long enough for the async ps lookup + append attempt to fail.
      await delay(300)

      // Task is still registered (createTask returned successfully).
      expect(task.taskId).toMatch(/^cpl_/)

      // The PID file was not created (the append failed).
      expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow()

      child.kill()
      deleteTask(task.taskId)
    } finally {
      console.warn = originalWarn
      // Restore writable mode so afterEach's rmSync can clean up.
      try {
        chmodSync(readonlyDir, 0o700)
      } catch {
        // best-effort
      }
    }
  })

  it('warns and skips append when ps lookup returns null', async () => {
    // Use a never-existed PID so getPidIdentity returns null.
    // PIDs above 2^22 are guaranteed unused on Linux/macOS (kernel pid_max).
    const ghostPid = 4_194_305

    const dir = mkdtempSync(join(tmpdir(), 'task-registry-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const abortController = new AbortController()
    // Capture console.warn output so we can assert the warning fires.
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)

    try {
      const task = createTask(
        {
          parentSessionID: 'session-1',
          pid: ghostPid,
          startedAt: Date.now(),
          status: 'running',
          args: ['-c', 'sleep 30'],
          cwd: process.cwd(),
          stdoutLineBuffer: '',
          events: [],
          // Double-cast through unknown: this fixture intentionally only sets
          // pid because the silent-skip path under test exits before any other
          // child property is read.
          child: { pid: ghostPid } as unknown as ReturnType<typeof Bun.spawn>,
          completionPromise: Promise.resolve(),
          abortController,
          pidFilePath,
        },
        undefined,
      )

      await delay(200)

      // PID file should not have been created — neither comm nor lstart resolved.
      expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow()

      // The silent-skip warning must be observable.
      const matched = warnings.find((w) =>
        w.includes(
          `[task-registry] ps lookup returned null for pid ${ghostPid}`,
        ),
      )
      expect(matched).toBeTruthy()

      deleteTask(task.taskId)
    } finally {
      console.warn = originalWarn
    }
  })
})
