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
  /** Override the binary to spawn. Test seam; defaults to `opencode`. */
  command?: string
  /**
   * Additional env vars to pass to the spawned `opencode` subprocess. Merged on top of
   * `process.env`. Use this to scope test-specific credentials (e.g. `GH_TOKEN`) to the
   * subprocess rather than mutating the parent test process's environment.
   */
  env?: Record<string, string>
}

const STDERR_BUFFER_CAP = 200
const LISTENING_RE = /listening on (https?:\/\/[^\s]+)/i
const HEALTH_POLL_INTERVAL_MS = 100
const HEALTH_FETCH_TIMEOUT_MS = 500
const PS_READ_TIMEOUT_MS = 1_000

// Env vars whose values, if present at spawn time, should be redacted from
// child stderr before being interpolated into thrown error messages. Defense
// in depth: the trust model already isolates env passthrough to the trusted
// local subprocess chain, but failure-path stderr surfaces in CI logs.
const KNOWN_TOKEN_ENV_VARS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'NPM_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

const TOKEN_PREFIX_RE =
  /\b(?:ghp_|ghs_|ghu_|ghr_|gho_|github_pat_)[A-Za-z0-9_]{16,}/g

function buildRedactor(env: NodeJS.ProcessEnv): (text: string) => string {
  const exactValues: string[] = []
  for (const name of KNOWN_TOKEN_ENV_VARS) {
    const v = env[name]
    if (typeof v === 'string' && v.length >= 16) exactValues.push(v)
  }
  return (text: string): string => {
    let out = text
    for (const v of exactValues) out = out.split(v).join('<redacted>')
    return out.replace(TOKEN_PREFIX_RE, '<redacted>')
  }
}

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

  const processLine = (line: string): void => {
    if (sink === 'stderr') {
      state.stderrLines.push(line)
      if (state.stderrLines.length > STDERR_BUFFER_CAP)
        state.stderrLines.shift()
    } else {
      // The listening URL is logged to stdout; only match there to avoid a
      // stderr warning latching the wrong baseUrl.
      const m = line.match(LISTENING_RE)
      if (m?.[1]) state.setBaseUrl(m[1])
    }
  }

  stream.on('data', (chunk: string) => {
    buffer += chunk
    let idx = buffer.indexOf('\n')
    while (idx !== -1) {
      processLine(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      idx = buffer.indexOf('\n')
    }
  })

  // Flush any remaining partial line on stream end/close. Without this, the
  // most useful diagnostic line (or the listening URL) can be lost if opencode
  // exits without a trailing newline.
  const flush = (): void => {
    if (buffer.length > 0) {
      processLine(buffer)
      buffer = ''
    }
  }
  stream.on('end', flush)
  stream.on('close', flush)

  stream.on('error', (err: Error) => {
    state.stderrLines.push(`[${sink} stream error] ${err.message}`)
    if (state.stderrLines.length > STDERR_BUFFER_CAP) state.stderrLines.shift()
  })
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
  // Bound the read so a wedged `ps` cannot hang teardown. On timeout we kill
  // the subprocess and skip descendant enumeration; the fkill(-pid, ...) group
  // signal in the caller still terminates the tree.
  const textPromise = new Response(proc.stdout).text()
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PS_READ_TIMEOUT_MS)
  })
  const result = await Promise.race([textPromise, timeoutPromise])
  if (timer) clearTimeout(timer)
  if (result === null) {
    proc.kill('SIGKILL')
    return ''
  }
  await proc.exited
  return result
}

async function collectDescendants(rootPid: number): Promise<number[]> {
  const text = await readPsTable()
  if (text.length === 0) return []
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
    const current = stack.pop()
    if (current === undefined) break
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
  // Sweep descendants from the pre-fkill snapshot. We don't probe with signal 0 first because
  // safeKill already swallows ESRCH on already-dead processes, and a probe-then-kill sequence
  // introduces a TOCTOU race where the PID could be reused between the probe and the SIGKILL.
  for (const target of [...descendants, pid]) {
    safeKill(target, 'SIGKILL')
  }
}

/**
 * Spawn `opencode serve --port 0 --print-logs` and resolve once the server is listening
 * and `/global/health` reports `healthy: true`. Rejects if the subprocess exits before
 * the health check succeeds, including the last 20 lines of stderr (with token values
 * redacted) in the error message.
 */
export async function startServer(
  opts: StartOptions = {},
): Promise<ServerHandle> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const command = opts.command ?? 'opencode'
  const args = [
    'serve',
    '--port',
    '0',
    '--print-logs',
    ...(opts.extraArgs ?? []),
  ]

  const redact = buildRedactor(process.env)

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: '',
      ...opts.env,
    },
  })
  const pid = child.pid ?? -1
  let stopped = false

  const stderrLines: string[] = []
  let baseUrl: string | undefined
  let exitCode: number | null = null
  let exited = false
  let spawnError: NodeJS.ErrnoException | undefined

  child.once('exit', (code: number | null) => {
    exited = true
    exitCode = code
  })
  child.once('error', (err: NodeJS.ErrnoException) => {
    exited = true
    spawnError = err
  })

  const drainState: DrainState = {
    stderrLines,
    setBaseUrl: (url) => {
      if (!baseUrl) baseUrl = url
    },
  }
  attachStreamDrain(child.stdout, 'stdout', drainState)
  attachStreamDrain(child.stderr, 'stderr', drainState)

  // Idempotent: a second stop() on the same handle is a no-op. This prevents the rare but
  // dangerous case where the original PID is reused by an unrelated process between the first
  // stop() and a follow-up stop() in a finally block, causing us to SIGKILL the wrong process.
  const stop = async (): Promise<void> => {
    if (stopped || pid <= 0) return
    stopped = true
    await killTreeAggressive(pid)
  }

  const formatTail = (): string => redact(stderrLines.slice(-20).join('\n'))

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (spawnError) {
      const code = spawnError.code ?? 'unknown'
      throw new Error(
        `failed to spawn '${command}' (${code}): ${spawnError.message}`,
      )
    }
    if (exited) {
      const tail = formatTail()
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
  const tail = formatTail()
  throw new Error(
    `opencode health check timed out after ${timeoutMs}ms\n` +
      `baseUrl=${baseUrl ?? '(not parsed)'}\n` +
      `stderr tail:\n${tail}`,
  )
}
