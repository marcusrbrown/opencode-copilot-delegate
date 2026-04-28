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
}

function flushBufferedStdout(task: SpawnCopilotResult): void {
  if (task.stdoutLineBuffer.trim().length === 0) {
    task.stdoutLineBuffer = ''
    return
  }

  task.events.push(parseJsonlLine(task.stdoutLineBuffer))
  task.stdoutLineBuffer = ''
}

function assignFinalMessage(task: SpawnCopilotResult): void {
  const lastMessage = [...task.events]
    .reverse()
    .find((event) => event.type === 'message')
  const content = lastMessage?.data?.content

  if (typeof content === 'string' && content.length > 0) {
    task.finalMessage = stripAnsi(content)
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

      setStatus(task, 'cancelled', { pidFilePath: opts.pidFilePath })
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
      finalizeTask(task, code, stderrText, opts.pidFilePath)
      resolve()
    })
  })

  return task
}
