import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Each `?instance=N` import is a separate module instance, standing in for
// the fresh module evaluation OpenCode performs per config source or
// workspace directory. Process-wide state must be shared across them.
const SRC = join(import.meta.dir, '..', 'src')

async function freshImport<T>(relativePath: string, instance: string) {
  return (await import(`${join(SRC, relativePath)}?instance=${instance}`)) as T
}

type RegistryModule = typeof import('../src/runtime/task-registry')
type PidFileModule = typeof import('../src/runtime/pid-file')
type NotifyModule = typeof import('../src/runtime/notify')

const tempPaths: string[] = []
const children: Array<ReturnType<typeof Bun.spawn>> = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill()
  const registry = await freshImport<RegistryModule>(
    'runtime/task-registry.ts',
    'cleanup',
  )
  await registry.cleanupAll()
  for (const p of tempPaths.splice(0))
    rmSync(p, { force: true, recursive: true })
})

describe('process core shared across module instances', () => {
  it('a task created through one instance is listed by another', async () => {
    // Given two independent module instances of the task registry
    const a = await freshImport<RegistryModule>('runtime/task-registry.ts', 'a')
    const b = await freshImport<RegistryModule>('runtime/task-registry.ts', 'b')
    expect(a.getAllTasks).not.toBe(b.getAllTasks)

    // When instance A registers a task
    const child = Bun.spawn({ cmd: ['sleep', '30'] })
    children.push(child)
    const task = a.createTask({
      parentSessionID: 'session-shared',
      pid: child.pid,
      startedAt: Date.now(),
      status: 'running',
      args: ['-p', 'x'],
      cwd: '/workspace-a',
      stdoutLineBuffer: '',
      events: [],
      child,
      completionPromise: child.exited.then(() => undefined),
      abortController: new AbortController(),
    })

    // Then instance B (what the single RPC server reads) sees it
    expect(b.getTask(task.taskId)?.cwd).toBe('/workspace-a')
    expect(b.getAllTasks().map((t) => t.taskId)).toContain(task.taskId)
  })

  it('concurrent ledger writes from two instances leave the ledger exact', async () => {
    // Given two module instances writing the same PID ledger concurrently
    const a = await freshImport<PidFileModule>('runtime/pid-file.ts', 'a')
    const b = await freshImport<PidFileModule>('runtime/pid-file.ts', 'b')
    const dir = mkdtempSync(join(tmpdir(), 'process-core-ledger-'))
    tempPaths.push(dir)
    const ledger = join(dir, 'test.pids')

    // When both append interleaved, then both remove half of them
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? a : b).appendPidEntry(ledger, 1000 + i, 'c', `t${i}`),
      ),
    )
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? b : a).removePidEntry(ledger, 1000 + i * 2),
      ),
    )

    // Then no read-modify-write cycle was lost: exactly the odd PIDs remain
    const pids = readFileSync(ledger, 'utf8')
      .trim()
      .split('\n')
      .map((line) => Number(line.split('\t')[0]))
      .sort((x, y) => x - y)
    expect(pids).toEqual(Array.from({ length: 10 }, (_, i) => 1001 + i * 2))
  })

  it('in-flight counters are shared, so noReply counts tasks from every instance', async () => {
    // Given two module instances of notify and one parent session
    const a = await freshImport<NotifyModule>('runtime/notify.ts', 'a')
    const b = await freshImport<NotifyModule>('runtime/notify.ts', 'b')
    a.resetInFlightCounters()
    const noReplies: boolean[] = []
    const client = {
      session: {
        prompt: async (opts: { body: { noReply: boolean } }) => {
          noReplies.push(opts.body.noReply)
        },
      },
      app: { log: async () => {} },
    }
    const task = (taskId: string) => ({
      taskId,
      parentSessionID: 'parent-1',
      status: 'complete' as const,
      startedAt: 0,
    })

    // When the session has one task in flight through each instance
    a.incrementInFlight('parent-1')
    b.incrementInFlight('parent-1')
    await b.notifyCompletion(client, task('cpl_first'))
    await a.notifyCompletion(client, task('cpl_second'))

    // Then the first completion stays silent (one still running elsewhere)
    // and only the last one wakes the parent
    expect(noReplies).toEqual([true, false])
    a.resetInFlightCounters()
  })
})
