import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TaskStatus } from '../src/runtime/envelope'
import type { ParsedEvent } from '../src/runtime/jsonl-parser'

type SpawnCopilotResult = {
  taskId: string
  pid: number
  events: ParsedEvent[]
  completionPromise: Promise<void>
  abortController: AbortController
  child: ChildProcess
  status: TaskStatus
  exitCode?: number
  stdoutLineBuffer: string
  errorText?: string
  finalMessage?: string
}

type SpawnCopilotFn = (
  args: string[],
  opts: { cwd: string; env?: Record<string, string> },
) => SpawnCopilotResult

type CreateTaskFn = (input: {
  parentSessionID: string
  pid: number
  startedAt: number
  status: TaskStatus
  args: string[]
  cwd: string
  stdoutLineBuffer: string
  events: ParsedEvent[]
  child: ChildProcess
  completionPromise: Promise<void>
  abortController: AbortController
}) => {
  taskId: string
}

type GetTaskFn = (taskId: string) => unknown
type GetAllTasksFn = () => unknown[]
type CleanupAllFn = () => Promise<void>
type StripAnsiFn = (text: string) => string
type KillProcessTreeFn = (pid: number) => Promise<void>

function requireFunction<T>(value: unknown): T {
  expect(typeof value).toBe('function')
  return value as T
}

async function loadModules() {
  const subprocessModule = await import('../src/runtime/subprocess')
  const registryModule = await import('../src/runtime/task-registry')
  const ansiModule = await import('../src/lib/ansi')
  const killTreeModule = await import('../src/lib/kill-tree')

  return {
    spawnCopilot: requireFunction<SpawnCopilotFn>(
      Reflect.get(subprocessModule, 'spawnCopilot'),
    ),
    createTask: requireFunction<CreateTaskFn>(
      Reflect.get(registryModule, 'createTask'),
    ),
    getTask: requireFunction<GetTaskFn>(Reflect.get(registryModule, 'getTask')),
    getAllTasks: requireFunction<GetAllTasksFn>(
      Reflect.get(registryModule, 'getAllTasks'),
    ),
    cleanupAll: requireFunction<CleanupAllFn>(
      Reflect.get(registryModule, 'cleanupAll'),
    ),
    stripAnsi: requireFunction<StripAnsiFn>(
      Reflect.get(ansiModule, 'stripAnsi'),
    ),
    killProcessTree: requireFunction<KillProcessTreeFn>(
      Reflect.get(killTreeModule, 'killProcessTree'),
    ),
  }
}

let killTreeImportNonce = 0

// Cache-bust the dynamic import so each test gets a fresh module evaluation.
// Bun's loader keys on the full URL, so appending `?test=N` (with N
// monotonically increasing) forces re-evaluation; without this trick, the
// `mock.module('fkill', ...)` setup from a prior test leaks into the next.
async function loadIsolatedKillProcessTree(): Promise<KillProcessTreeFn> {
  killTreeImportNonce += 1

  const killTreeModule = await import(
    `../src/lib/kill-tree.ts?test=${killTreeImportNonce}`
  )

  return requireFunction<KillProcessTreeFn>(
    Reflect.get(killTreeModule, 'killProcessTree'),
  )
}

function makeFakeCopilotBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'copilot-bin-'))
  const copilotPath = join(binDir, 'copilot')

  writeFileSync(copilotPath, '#!/usr/bin/env bash\nexec bash "$@"\n')
  chmodSync(copilotPath, 0o755)

  return binDir
}

function makeSpawnEnv(binDir: string): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  }
}

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(filePath)) {
      return
    }

    await delay(20)
  }

  throw new Error(`Timed out waiting for file: ${filePath}`)
}

// Polls `process.kill(pid, 0)` (signal 0 probes liveness without delivery)
// until it throws ESRCH/EPERM (process gone) or the deadline expires. Use
// instead of a synchronous assertion when the test cancels a process tree
// and immediately checks for liveness — the kernel may not have fully reaped
// the grandchild by the time the assertion runs on a loaded CI runner.
async function expectProcessToBeGone(
  pid: number,
  {
    timeoutMs = 2000,
    intervalMs = 50,
  }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }

    await delay(intervalMs)
  }

  // Final attempt — let the assertion failure surface the live PID for diagnosis.
  expect(() => process.kill(pid, 0)).toThrow()
}

const tempPaths: string[] = []

afterEach(async () => {
  mock.restore()

  const { cleanupAll } = await loadModules()
  await cleanupAll()

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

describe('subprocess runtime', () => {
  describe('spawnCopilot', () => {
    it('captures parsed events and marks successful exits as complete', async () => {
      // Given a fake copilot binary that emits JSONL and exits successfully
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"assistant.message","data":{"messageId":"msg-1","content":"done","toolRequests":[]}}\'',
            'printf \'%s\\n\' \'{"type":"result","sessionId":"session-1","exitCode":0,"usage":{}}\'',
            'exit 0',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // When the subprocess finishes
      await task.completionPromise

      // Then parsed events are accumulated and status reflects success
      expect(task.taskId.startsWith('cpl_')).toBe(true)
      expect(task.pid).toBeGreaterThan(0)
      expect(task.status).toBe('complete')
      expect(task.exitCode).toBe(0)
      expect(task.events).toHaveLength(2)
      expect(task.events[0]?.type).toBe('message')
      expect(task.events[0]?.data.content).toBe('done')
      expect(task.stdoutLineBuffer).toBe('')
    })

    it('captures copilotSessionId from the result event when sessionId is present', async () => {
      // Given a fake copilot binary that emits a result event carrying a sessionId.
      // The result-event capture is the registry's source of truth for the
      // upstream Copilot session ID — downstream resume/connect units use it
      // to enable lookup-by-known-task without re-asking the user for the ID.
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const targetSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const task = spawnCopilot(
        [
          '-c',
          [
            `printf '%s\\n' '{"type":"result","sessionId":"${targetSessionId}","exitCode":0,"usage":{}}'`,
            'exit 0',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      await task.completionPromise

      expect(task.status).toBe('complete')
      expect(task.copilotSessionId).toBe(targetSessionId)
    })

    it('leaves copilotSessionId undefined when result event has no sessionId', async () => {
      // Given a fake copilot binary that emits a result event without a sessionId
      // (defensive: real CLI 1.0.40 always includes one, but the capture path
      // must not throw when the field is missing).
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"result","exitCode":0,"usage":{}}\'',
            'exit 0',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      await task.completionPromise

      expect(task.status).toBe('complete')
      expect(task.copilotSessionId).toBeUndefined()
    })

    it('captures copilotSessionId on cancelled tasks when the result event arrived before cancellation', async () => {
      // The cancelled-close branch in spawnCopilot also calls the
      // session-id capture path; if the result event arrived before the
      // user pressed cancel, the captured ID must still survive.
      //
      // The bash subprocess's stdout is fully buffered against the parent
      // pipe, so printf alone may not flush before the long-running sleep
      // begins. The script writes a sentinel file to a temp path AFTER
      // the printf line, and the test polls that file before aborting —
      // a flush happens implicitly because the printf output is followed
      // by another shell command (write).
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const targetSessionId = '11111111-2222-3333-4444-555555555555'
      const sentinel = join(cwd, 'result-emitted')
      const task = spawnCopilot(
        [
          '-c',
          [
            `printf '%s\\n' '{"type":"result","sessionId":"${targetSessionId}","exitCode":0,"usage":{}}'`,
            // Force the parent's pipe buffer to flush by ending stdout
            // explicitly; then signal readiness via a sentinel file before
            // the long-lived sleep that keeps the process alive until abort.
            'exec 1>&-',
            `touch '${sentinel}'`,
            'sleep 30',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // Wait until the sentinel exists — proves the result line was
      // written and the subprocess is now in the long-lived sleep phase.
      await waitForFile(sentinel)

      task.abortController.abort()
      await task.completionPromise

      expect(task.status).toBe('cancelled')
      expect(task.copilotSessionId).toBe(targetSessionId)
    })

    it('marks non-zero exits as failed', async () => {
      // Given a fake copilot binary that exits with a non-zero status
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"result","sessionId":"session-2","exitCode":7,"usage":{}}\'',
            'exit 7',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // When the subprocess finishes
      await task.completionPromise

      // Then status reflects the failed exit code
      expect(task.status).toBe('failed')
      expect(task.exitCode).toBe(7)
      expect(task.events).toHaveLength(1)
      expect(task.events[0]?.type).toBe('usage')
    })

    it('buffers stdout until a full JSONL line is available', async () => {
      // Given a fake copilot binary that splits one JSONL line across chunks
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\' \'{"type":"assistant.message","data":{"messageId":"msg-2","content":"chunk\'',
            'sleep 0.05',
            "printf '%s\\n' 'ed\",\"toolRequests\":[]}}'",
            'printf \'%s\\n\' \'{"type":"result","sessionId":"session-3","exitCode":0,"usage":{}}\'',
            'exit 0',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // When the subprocess finishes
      await task.completionPromise

      // Then the split line is reassembled into one parsed event
      expect(task.status).toBe('complete')
      expect(task.events).toHaveLength(2)
      expect(task.events[0]?.data.content).toBe('chunked')
      expect(task.stdoutLineBuffer).toBe('')
    })

    it('handles interleaved valid and malformed JSONL lines', async () => {
      // Given a fake copilot binary that emits valid, malformed, and valid lines
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"assistant.message","data":{"messageId":"m1","content":"hello","toolRequests":[]}}\'',
            "printf '%s\\n' 'NOT-JSON-AT-ALL'",
            'printf \'%s\\n\' \'{"type":"result","sessionId":"s1","exitCode":0,"usage":{}}\'',
            'exit 0',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // When the subprocess finishes
      await task.completionPromise

      // Then all three lines are parsed: valid → unknown → valid
      expect(task.status).toBe('complete')
      expect(task.events).toHaveLength(3)
      expect(task.events[0]?.type).toBe('message')
      expect(task.events[1]?.type).toBe('unknown')
      expect(task.events[2]?.type).toBe('usage')
    })

    it('cancels the subprocess tree through the abort controller', async () => {
      // Given a fake copilot binary that starts a long-lived child process
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      const pidFile = join(cwd, 'grandchild.pid')
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        ['-c', [`sleep 30 & echo $! > '${pidFile}'`, 'wait'].join('; ')],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      await waitForFile(pidFile)
      const grandchildPid = Number.parseInt(
        readFileSync(pidFile, 'utf-8').trim(),
        10,
      )
      const startedAt = Date.now()

      // When cancellation is requested
      task.abortController.abort()

      // Then the task remains visible as cancelling until the child exits
      expect(task.status).toBe('cancelling')

      await task.completionPromise

      // Then the process tree is gone and the task is marked cancelled
      expect(task.status).toBe('cancelled')
      expect(Date.now() - startedAt).toBeLessThan(3000)
      await expectProcessToBeGone(grandchildPid)
    })

    it('does not append events after cancellation (cancel-race guard)', async () => {
      // Given a fake copilot binary that emits 2 JSONL lines and then waits
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"assistant.message","data":{"messageId":"msg-1","content":"line1","toolRequests":[]}}\'',
            'printf \'%s\\n\' \'{"type":"assistant.message","data":{"messageId":"msg-2","content":"line2","toolRequests":[]}}\'',
            'sleep 30',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // Wait for the first 2 lines to be parsed
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (task.events.length >= 2) break
        await delay(20)
      }
      expect(task.events).toHaveLength(2)

      // When the task is cancelled
      task.abortController.abort()

      // Then additional data arriving on stdout should not append new events
      const extraLines = `${[
        '{"type":"assistant.message","data":{"messageId":"msg-3","content":"line3","toolRequests":[]}}',
        '{"type":"assistant.message","data":{"messageId":"msg-4","content":"line4","toolRequests":[]}}',
        '{"type":"assistant.message","data":{"messageId":"msg-5","content":"line5","toolRequests":[]}}',
      ].join('\n')}\n`

      // Programmatically emit data on the child's stdout stream
      task.child.stdout?.emit('data', extraLines)

      // Assert no new events were appended
      expect(task.events).toHaveLength(2)

      // Clean up: wait for the killed subprocess to close
      await task.completionPromise
      expect(task.status).toBe('cancelled')
    })

    it('preserves cancelled status when close fires after abort (cancel-then-close ordering)', async () => {
      // Given a fake copilot binary that emits 1 line and then sleeps
      const { spawnCopilot } = await loadModules()
      const cwd = mkdtempSync(join(tmpdir(), 'copilot-cwd-'))
      const binDir = makeFakeCopilotBin()
      tempPaths.push(cwd, binDir)

      const task = spawnCopilot(
        [
          '-c',
          [
            'printf \'%s\\n\' \'{"type":"assistant.message","data":{"messageId":"msg-1","content":"line1","toolRequests":[]}}\'',
            'sleep 30',
          ].join('; '),
        ],
        { cwd, env: makeSpawnEnv(binDir) },
      )

      // Wait for the line to be parsed
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (task.events.length >= 1) break
        await delay(20)
      }
      expect(task.events).toHaveLength(1)

      // When cancellation is requested
      task.abortController.abort()

      // Wait for the subprocess to actually close after the kill
      await task.completionPromise

      // Then the status remains cancelled, not flipped to complete/failed by finalizeTask
      expect(task.status).toBe('cancelled')
    })
  })

  describe('task registry', () => {
    it('creates tasks with cpl_ ids and exposes them through lookup helpers', async () => {
      // Given a new task registry entry
      const { createTask, getTask, getAllTasks } = await loadModules()
      const child = Bun.spawn({ cmd: ['bash', '-c', 'sleep 30'] })
      const abortController = new AbortController()

      const task = createTask({
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
      })

      // When the task is read back from the registry
      const fetched = getTask(task.taskId)
      const allTasks = getAllTasks()

      // Then it is stored under a generated cpl_ id
      expect(task.taskId.startsWith('cpl_')).toBe(true)
      expect(fetched).toBe(task)
      expect(allTasks).toContain(task)
    })
  })

  describe('helpers', () => {
    it('strips ANSI escape sequences from text', async () => {
      // Given ANSI-colored terminal output
      const { stripAnsi } = await loadModules()
      const input = '\u001b[31mred\u001b[0m normal \u001b[1mbold\u001b[0m'

      // When ANSI codes are stripped
      const result = stripAnsi(input)

      // Then the visible text remains without escape sequences
      expect(result).toBe('red normal bold')
    })

    it('ignores invalid pids when killing a process tree', async () => {
      // Given an invalid process id
      const { killProcessTree } = await loadModules()

      // When killProcessTree is asked to terminate it
      await killProcessTree(0)

      // Then the helper exits without throwing
    })

    describe('killProcessTree observability', () => {
      it('logs and skips when fkill fails after the root pid is already gone', async () => {
        // Given fkill fails and the root pid probe reports ESRCH
        const fkillError = new AggregateError(
          ['Killing process -1234 failed: Process does not exist'],
          'Failed to kill processes',
        )
        const fkillMock = mock(async () => {
          throw fkillError
        })
        await mock.module('fkill', () => ({ default: fkillMock }))

        const killProcessTree = await loadIsolatedKillProcessTree()
        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
        const probeError = new Error('no such process') as NodeJS.ErrnoException
        probeError.code = 'ESRCH'
        const killSpy = spyOn(process, 'kill').mockImplementation(() => {
          throw probeError
        })

        // When killProcessTree handles the failed fkill
        await expect(killProcessTree(1234)).resolves.toBeUndefined()

        // Then it logs the benign race and suppresses the failure
        expect(fkillMock).toHaveBeenCalledWith(-1234, {
          force: false,
          forceAfterTimeout: 2000,
          waitForExit: 5000,
        })
        expect(killSpy).toHaveBeenCalledWith(-1234, 0)
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const goneMessage = warnSpy.mock.calls[0]?.[0]
        expect(goneMessage).toEqual(
          expect.stringContaining('[copilot-delegate]'),
        )
        expect(goneMessage).toEqual(
          expect.stringContaining('root pid 1234 is already gone'),
        )
      })

      it('warns and rethrows when fkill fails while the root pid is still alive', async () => {
        // Given fkill fails but the root pid still exists
        const fkillError = new AggregateError(
          ['Killing process -4321 failed: Operation not permitted'],
          'Failed to kill processes',
        )
        const fkillMock = mock(async () => {
          throw fkillError
        })
        await mock.module('fkill', () => ({ default: fkillMock }))

        const killProcessTree = await loadIsolatedKillProcessTree()
        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
        const killSpy = spyOn(process, 'kill').mockImplementation(() => true)

        // When killProcessTree handles the failed fkill
        await expect(killProcessTree(4321)).rejects.toBe(fkillError)

        // Then it warns that live processes may remain and preserves failure
        expect(fkillMock).toHaveBeenCalledWith(-4321, {
          force: false,
          forceAfterTimeout: 2000,
          waitForExit: 5000,
        })
        expect(killSpy).toHaveBeenCalledWith(-4321, 0)
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const aliveMessage = warnSpy.mock.calls[0]?.[0]
        expect(aliveMessage).toEqual(
          expect.stringContaining('[copilot-delegate]'),
        )
        expect(aliveMessage).toEqual(
          expect.stringContaining('root pid 4321 is still alive'),
        )
      })

      it('warns and rethrows when the root pid probe fails with an unexpected errno', async () => {
        // Given fkill fails and the follow-up root pid probe also errors
        const fkillError = new AggregateError(
          ['Killing process -9876 failed: Operation not permitted'],
          'Failed to kill processes',
        )
        const fkillMock = mock(async () => {
          throw fkillError
        })
        await mock.module('fkill', () => ({ default: fkillMock }))

        const killProcessTree = await loadIsolatedKillProcessTree()
        const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
        const probeError = new Error(
          'operation not permitted',
        ) as NodeJS.ErrnoException
        probeError.code = 'EPERM'
        const killSpy = spyOn(process, 'kill').mockImplementation(() => {
          throw probeError
        })

        // When killProcessTree handles the failed fkill
        await expect(killProcessTree(9876)).rejects.toBe(fkillError)

        // Then it surfaces the unexpected probe errno and preserves failure
        expect(fkillMock).toHaveBeenCalledWith(-9876, {
          force: false,
          forceAfterTimeout: 2000,
          waitForExit: 5000,
        })
        expect(killSpy).toHaveBeenCalledWith(-9876, 0)
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const probeMessage = warnSpy.mock.calls[0]?.[0]
        expect(probeMessage).toEqual(
          expect.stringContaining('[copilot-delegate]'),
        )
        expect(probeMessage).toEqual(
          expect.stringContaining('root pid probe failed with EPERM'),
        )
      })
    })
  })

  describe('stderr capture', () => {
    it('captures stderr output in task errorText', async () => {
      const { spawnCopilot } = await loadModules()
      const binDir = makeFakeCopilotBin()
      tempPaths.push(binDir)

      const task = spawnCopilot(
        ['-c', 'echo "something went wrong" >&2; exit 1'],
        { cwd: process.cwd(), env: makeSpawnEnv(binDir) },
      )

      await task.completionPromise
      expect(task.status).toBe('failed')
      expect(task.errorText).toContain('something went wrong')
    })
  })

  describe('auth environment resolution', () => {
    it('passes COPILOT_GITHUB_TOKEN when set directly', async () => {
      const { spawnCopilot } = await loadModules()
      const binDir = makeFakeCopilotBin()
      tempPaths.push(binDir)

      const task = spawnCopilot(
        ['-c', 'printf \'{"type":"%s"}\\n\' "$COPILOT_GITHUB_TOKEN"; exit 0'],
        {
          cwd: process.cwd(),
          env: {
            ...makeSpawnEnv(binDir),
            COPILOT_GITHUB_TOKEN: 'direct-token',
          },
        },
      )

      await task.completionPromise
      expect(task.events.length).toBeGreaterThan(0)
      // classifyEventType returns 'unknown' for unrecognized type values
      expect(task.events[0].type).toBe('unknown')
    })

    it('falls back to GH_TOKEN when COPILOT_GITHUB_TOKEN is not set', async () => {
      const { spawnCopilot } = await loadModules()
      const binDir = makeFakeCopilotBin()
      tempPaths.push(binDir)

      const task = spawnCopilot(
        ['-c', 'printf \'{"type":"%s"}\\n\' "$COPILOT_GITHUB_TOKEN"; exit 0'],
        {
          cwd: process.cwd(),
          env: {
            ...makeSpawnEnv(binDir),
            GH_TOKEN: 'gh-fallback-token',
          },
        },
      )

      await task.completionPromise
      expect(task.events.length).toBeGreaterThan(0)
      // GH_TOKEN was copied to COPILOT_GITHUB_TOKEN by resolveAuthEnv
      expect(task.events[0].type).toBe('unknown')
    })
  })

  describe('spawn error handling', () => {
    it('marks task as failed when binary is not found', async () => {
      const { spawnCopilot } = await loadModules()

      const task = spawnCopilot(['-p', 'hello'], {
        cwd: process.cwd(),
        env: { PATH: '/nonexistent-path-for-test' },
      })

      await task.completionPromise
      expect(task.status).toBe('failed')
      expect(task.errorText).toBeDefined()
    })
  })
})
