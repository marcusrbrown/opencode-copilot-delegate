import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
          // biome-ignore lint/suspicious/noExplicitAny: ghost-pid fixture has no real child
          child: { pid: ghostPid } as any,
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
