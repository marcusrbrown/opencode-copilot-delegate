import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stripAnsi } from '../lib/ansi'
import { killProcessTree } from '../lib/kill-tree'
import type { TaskStatus } from './envelope'
import { type ParsedEvent, parseJsonlLine } from './jsonl-parser'
import { setStatus } from './task-status'

type SpawnCopilotOptions = {
  cwd: string
  env?: Record<string, string>
  pidFilePath?: string
}

export type SpawnCopilotResult = {
  taskId: string
  pid: number
  events: ParsedEvent[]
  completionPromise: Promise<void>
  abortController: AbortController
  child: ChildProcess
  status: TaskStatus
  exitCode?: number
  endedAt?: number
  stdoutLineBuffer: string
  finalMessage?: string
  errorText?: string
  /**
   * Upstream Copilot session UUID captured from the terminal `result`
   * JSONL event. Populated alongside `assignFinalMessage` in both the
   * happy-path (`finalizeTask`) and cancelled-close branches; left
   * undefined when no `result` event arrived (process killed early or
   * crashed before emitting one).
   */
  copilotSessionId?: string
}

function flushBufferedStdout(task: SpawnCopilotResult): void {
  // Cancel-race guard: drop any post-cancel partial line. Without this,
  // bytes that arrived after the abort listener fired could be parsed and
  // pushed to task.events even though task.status is already 'cancelled'.
  // Mirrors the per-line guard in the data handler below.
  if (task.status !== 'running') {
    task.stdoutLineBuffer = ''
    return
  }
  if (task.stdoutLineBuffer.trim().length === 0) {
    task.stdoutLineBuffer = ''
    return
  }

  task.events.push(parseJsonlLine(task.stdoutLineBuffer))
  task.stdoutLineBuffer = ''
}

/**
 * Walk `task.events` backwards and return the first event matching the
 * predicate. Avoids the allocation cost of `[...arr].reverse().find()`,
 * which is meaningful for tasks with thousands of events. Mirrors the
 * pattern used in `envelope.ts:extractFinalMessage`.
 */
function findLastEvent(
  task: SpawnCopilotResult,
  predicate: (event: ParsedEvent) => boolean,
): ParsedEvent | undefined {
  const events = task.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && predicate(event)) return event
  }
  return undefined
}

function assignFinalMessage(task: SpawnCopilotResult): void {
  const lastMessage = findLastEvent(task, (event) => event.type === 'message')
  const content = lastMessage?.data?.content

  if (typeof content === 'string' && content.length > 0) {
    task.finalMessage = stripAnsi(content)
  }
}

function assignCopilotSessionId(task: SpawnCopilotResult): void {
  // The Copilot CLI's `result` JSONL event is the terminal usage event
  // (see jsonl-parser.ts: `case 'result'` returns type `'usage'`). Walk
  // events from the end — for typical sessions the result event is last,
  // but if a future CLI version emits trailing events the most recent
  // usage event is still the source of truth.
  const lastUsage = findLastEvent(task, (event) => event.type === 'usage')
  const sessionId = lastUsage?.data?.sessionId

  if (typeof sessionId === 'string' && sessionId.length > 0) {
    task.copilotSessionId = sessionId
  }
}

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

  if (stderrText.trim().length > 0) {
    task.errorText = stripAnsi(stderrText.trim())
  }

  assignFinalMessage(task)
  assignCopilotSessionId(task)
}

function resolveAuthEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const authToken = env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN ?? env.GITHUB_TOKEN

  if (!authToken) {
    return env
  }

  return {
    ...env,
    COPILOT_GITHUB_TOKEN: authToken,
  }
}

export function spawnCopilot(
  args: string[],
  opts: SpawnCopilotOptions,
): SpawnCopilotResult {
  const env = resolveAuthEnv({
    ...process.env,
    ...opts.env,
  })

  const child = spawn('copilot', args, {
    cwd: opts.cwd,
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const events: ParsedEvent[] = []
  const task: SpawnCopilotResult = {
    taskId: `cpl_${randomUUID()}`,
    pid: child.pid ?? -1,
    events,
    abortController: new AbortController(),
    child,
    status: 'running',
    exitCode: undefined,
    stdoutLineBuffer: '',
    completionPromise: Promise.resolve(),
  }

  let stderrText = ''

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    task.stdoutLineBuffer += chunk

    const lines = task.stdoutLineBuffer.split(/\r?\n/)
    task.stdoutLineBuffer = lines.pop() ?? ''

    for (const line of lines) {
      if (task.status !== 'running') break
      if (line.length === 0) {
        continue
      }

      const event = parseJsonlLine(line)
      events.push(event)
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderrText += chunk
  })

  task.abortController.signal.addEventListener(
    'abort',
    () => {
      if (task.status !== 'running') {
        return
      }

      setStatus(task, 'cancelling', { pidFilePath: opts.pidFilePath })
      killProcessTree(task.pid).catch(() => {
        // Kill failure after abort is non-fatal — process may already be dead
      })
    },
    { once: true },
  )

  task.completionPromise = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      setStatus(task, 'failed', { pidFilePath: opts.pidFilePath })
      task.errorText = stripAnsi(error.message)
      resolve()
    })

    child.once('close', (code) => {
      if (task.status === 'cancelling') {
        setStatus(task, 'cancelled', { pidFilePath: opts.pidFilePath })
        task.endedAt = Date.now()
        task.exitCode = code ?? undefined
        assignFinalMessage(task)
        assignCopilotSessionId(task)
      } else {
        finalizeTask(task, code, stderrText, opts.pidFilePath)
      }
      resolve()
    })
  })

  return task
}
