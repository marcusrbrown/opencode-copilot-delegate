import {
  type ChildProcessWithoutNullStreams,
  execSync,
  spawn,
} from 'node:child_process'
import { existsSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import fkill from 'fkill'

/**
 * Resolve the native `opencode` binary path, bypassing any wrapper scripts that
 * invoke `node` via `/usr/bin/env`. We do this because integration tests redirect
 * `HOME` and `XDG_*` for isolation; on developer machines where `node` is a mise
 * shim, the shim re-reads `mise.toml` trust state from the redirected XDG_DATA_HOME
 * and refuses to launch the wrapper.
 *
 * Resolution order:
 *   1. Explicit override via OPENCODE_BIN env var.
 *   2. The platform-specific native binary inside the npm install (where the
 *      `opencode-ai` wrapper points), which is a real Mach-O / ELF executable.
 *   3. Fall back to plain `opencode` and let PATH resolve it (CI-friendly when
 *      mise-action has already wired up PATH and trust).
 */
function resolveOpencodeBinary(): string {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  try {
    const which = execSync('mise which opencode', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (which) {
      // wrapper is at <install>/bin/opencode; native is at
      //   <install>/node_modules/opencode-<platform>-<arch>/bin/opencode
      const installPrefix = dirname(dirname(which))
      const platformDir = `opencode-${platform()}-${arch()}`
      const native = join(
        installPrefix,
        'node_modules',
        platformDir,
        'bin',
        'opencode',
      )
      if (existsSync(native)) return native
      return which
    }
  } catch {
    // fall through to PATH lookup
  }
  return 'opencode'
}

const RESOLVED_OPENCODE_BINARY = resolveOpencodeBinary()

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
  /**
   * Test home directory for OpenCode subprocess isolation. When provided, the subprocess
   * runs under a redirected `HOME` so it does not read the developer's real
   * `~/.config/opencode/opencode.json` (which would load OMO, Magic Context, and other
   * user plugins into throwaway test sessions and write storage under the user's data
   * dirs). Mirrors the `OPENCODE_TEST_HOME` pattern OpenCode itself uses in its own
   * test preload.
   */
  homeDir?: string
  /**
   * Test managed-config directory. Pairs with `homeDir` to isolate the subprocess from
   * any system-managed OpenCode configuration. Maps to `OPENCODE_TEST_MANAGED_CONFIG_DIR`.
   */
  managedConfigDir?: string
}

/**
 * Keys whose values are owned by `buildIsolationEnv` and must never be overridden by
 * caller-supplied `opts.env`. A caller that accidentally forwards one of these keys
 * (for example by passing `process.env` through verbatim) would silently defeat the
 * isolation that `homeDir` / `managedConfigDir` are meant to provide. We strip them
 * defensively in `startServer` before merging caller env into the spawn env.
 */
const ISOLATION_RESERVED_KEYS: ReadonlySet<string> = new Set([
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_TEST_HOME',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_AUTOUPDATE',
  'OPENCODE_DISABLE_LSP_DOWNLOAD',
  'OPENCODE_DISABLE_MODELS_FETCH',
  'OPENCODE_DISABLE_PRUNE',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
])

/**
 * Build the env-var block that isolates the spawned `opencode` subprocess from the
 * developer's real `~/` and `~/.config/opencode/`. Without this, every throwaway test
 * session would load every plugin listed in the developer's global `opencode.json`
 * (OMO, Magic Context, etc.) and write storage under their real `~/.local/share/opencode/`.
 *
 * What gets redirected:
 *   - `HOME`, `XDG_*`: redirect every config / data / cache / state path to the test home.
 *     The XDG vars are belt-and-suspenders: `OPENCODE_TEST_HOME` redirects OpenCode's own
 *     path resolution, but xdg-app-paths-style libraries used by transitive deps may pin
 *     `~/.config` from the original `HOME` at module load. Setting both guarantees any
 *     path resolution under the subprocess tree sees the test home, no matter when it runs.
 *   - `OPENCODE_TEST_HOME` / `OPENCODE_TEST_MANAGED_CONFIG_DIR`: matches OpenCode's own
 *     test-preload pattern from `packages/opencode/test/preload.ts`.
 *   - `OPENCODE_DISABLE_*`: cut out slow first-boot work paths (LSP server download,
 *     model registry fetch, prune, autoupdate, .claude scan).
 *
 * Why we redirect `HOME` rather than relying on `OPENCODE_PURE`: `OPENCODE_PURE=true` also
 * skips OpenCode's project-directory plugin scan, which is what discovers our
 * `.opencode/plugins/copilot-delegate.js`. Redirecting `HOME` is the only way to skip
 * the developer's globally configured plugins while keeping our own discoverable.
 *
 * Pre-condition for the caller: spawn the native opencode binary (not the JS wrapper),
 * because the wrapper's `#!/usr/bin/env node` shebang resolves to a mise shim on
 * developer machines, and mise's trust state lives under the original `XDG_DATA_HOME`.
 */
function buildIsolationEnv(
  homeDir: string,
  managedConfigDir: string,
): Record<string, string> {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: `${homeDir}/.config`,
    XDG_DATA_HOME: `${homeDir}/.local/share`,
    XDG_CACHE_HOME: `${homeDir}/.cache`,
    XDG_STATE_HOME: `${homeDir}/.local/state`,
    OPENCODE_TEST_HOME: homeDir,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: managedConfigDir,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PRUNE: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  }
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
  const command = opts.command ?? RESOLVED_OPENCODE_BINARY
  const args = [
    'serve',
    '--port',
    '0',
    '--print-logs',
    ...(opts.extraArgs ?? []),
  ]

  const redact = buildRedactor(process.env)

  // Both-or-neither: requiring `homeDir` without `managedConfigDir` (or vice-versa) would
  // silently fall back to no isolation, defeating the caller's intent. Fail loudly.
  if (Boolean(opts.homeDir) !== Boolean(opts.managedConfigDir)) {
    throw new Error(
      'startServer: homeDir and managedConfigDir must be provided together (or neither)',
    )
  }

  const isolationEnv =
    opts.homeDir && opts.managedConfigDir
      ? buildIsolationEnv(opts.homeDir, opts.managedConfigDir)
      : {}

  // Strip isolation-owned keys from caller env so a forwarded `HOME` / `XDG_*` cannot
  // silently override the isolation block. Credentials (`GH_TOKEN`, etc.) are not in the
  // reserved set and pass through normally.
  const safeCallerEnv: Record<string, string> = {}
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (ISOLATION_RESERVED_KEYS.has(k)) continue
      safeCallerEnv[k] = v
    }
  }

  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      OPENCODE_SERVER_PASSWORD: '',
      ...isolationEnv,
      // Caller-supplied env (excluding isolation-reserved keys) is layered last so
      // tests can forward credentials (e.g. GH_TOKEN) into the isolated subprocess.
      ...safeCallerEnv,
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
