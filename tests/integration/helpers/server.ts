import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fkill from 'fkill'

export interface ServerHandle {
  baseUrl: string
  pid: number
  stop(): Promise<void>
  stderrTail(): string[]
}

export interface StartOptions {
  cwd?: string
  /** Maximum time to wait for `/global/health` to return ok (default 10000). */
  timeoutMs?: number
  /** Extra args appended after `serve --port 0 --print-logs`. */
  extraArgs?: string[]
}

const STDERR_BUFFER_CAP = 200
const LISTENING_RE = /listening on (https?:\/\/[^\s]+)/i
const HEALTH_POLL_INTERVAL_MS = 100
const HEALTH_FETCH_TIMEOUT_MS = 500

interface DrainState {
  stderrLines: string[]
  setBaseUrl: (url: string) => void
}

function attachStreamDrain(
  stream: NodeJS.ReadableStream,
  sink: 'stdout' | 'stderr',
  state: DrainState,
): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (sink === 'stderr') {
        state.stderrLines.push(line)
        if (state.stderrLines.length > STDERR_BUFFER_CAP)
          state.stderrLines.shift()
      }
      const m = line.match(LISTENING_RE)
      if (m?.[1]) state.setBaseUrl(m[1])
      idx = buffer.indexOf('\n')
    }
  })
  stream.on('error', () => {})
}

async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      signal: AbortSignal.timeout(HEALTH_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const body = (await res.json().catch(() => null)) as {
      healthy?: boolean
    } | null
    return body?.healthy === true
  } catch {
    return false
  }
}

async function readPsTable(): Promise<string> {
  const proc = Bun.spawn(['ps', '-axo', 'pid,ppid'], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

async function collectDescendants(rootPid: number): Promise<number[]> {
  const text = await readPsTable()
  const childrenByParent = new Map<number, number[]>()
  for (const line of text.split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    const pidStr = parts[0]
    const ppidStr = parts[1]
    if (!pidStr || !ppidStr) continue
    const pid = Number.parseInt(pidStr, 10)
    const ppid = Number.parseInt(ppidStr, 10)
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    const arr = childrenByParent.get(ppid) ?? []
    arr.push(pid)
    childrenByParent.set(ppid, arr)
  }
  const out: number[] = []
  const stack = [rootPid]
  while (stack.length > 0) {
    const current = stack.pop() as number
    const kids = childrenByParent.get(current) ?? []
    for (const kid of kids) {
      out.push(kid)
      stack.push(kid)
    }
  }
  return out
}

function safeKill(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Kill the entire process tree rooted at `pid`. The `opencode` shim spawns a `.opencode`
 * child; in practice a single SIGTERM to the process group is not always sufficient because
 * the child can outlive the shim. We snapshot descendants before signalling, hit the group
 * via `fkill(-pid, ...)`, then sweep any descendants still alive with SIGKILL.
 */
async function killTreeAggressive(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) return
  const descendants = await collectDescendants(pid)
  try {
    await fkill(-pid, {
      force: false,
      forceAfterTimeout: 2_000,
      waitForExit: 5_000,
    })
  } catch {
    // process may already be gone; sweep below
  }
  for (const target of [...descendants, pid]) {
    if (safeKill(target, 0)) {
      safeKill(target, 'SIGKILL')
    }
  }
}

/**
 * Spawn `opencode serve --port 0 --print-logs` and resolve once the server is listening
 * and `/global/health` reports `healthy: true`. Rejects if the subprocess exits before
 * the health check succeeds, including the last 20 lines of stderr in the error message.
 */
export async function startServer(
  opts: StartOptions = {},
): Promise<ServerHandle> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const args = [
    'serve',
    '--port',
    '0',
    '--print-logs',
    ...(opts.extraArgs ?? []),
  ]

  const child: ChildProcessWithoutNullStreams = spawn('opencode', args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: '',
    },
  })
  const pid = child.pid ?? -1

  const stderrLines: string[] = []
  let baseUrl: string | undefined
  let exitCode: number | null = null
  let exited = false

  child.once('exit', (code: number | null) => {
    exited = true
    exitCode = code
  })
  child.once('error', () => {
    exited = true
  })

  const drainState: DrainState = {
    stderrLines,
    setBaseUrl: (url) => {
      if (!baseUrl) baseUrl = url
    },
  }
  attachStreamDrain(child.stdout, 'stdout', drainState)
  attachStreamDrain(child.stderr, 'stderr', drainState)

  const stop = async (): Promise<void> => {
    if (pid <= 0) return
    await killTreeAggressive(pid)
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (exited) {
      const tail = stderrLines.slice(-20).join('\n')
      throw new Error(
        `opencode exited with code ${exitCode} before health check\n` +
          `stderr tail (${Math.min(stderrLines.length, 20)} lines):\n${tail}`,
      )
    }
    if (baseUrl && (await probeHealth(baseUrl))) {
      return {
        baseUrl,
        pid,
        stop,
        stderrTail: () => stderrLines.slice(),
      }
    }
    await sleep(HEALTH_POLL_INTERVAL_MS)
  }

  await stop()
  const tail = stderrLines.slice(-20).join('\n')
  throw new Error(
    `opencode health check timed out after ${timeoutMs}ms\n` +
      `baseUrl=${baseUrl ?? '(not parsed)'}\n` +
      `stderr tail:\n${tail}`,
  )
}
