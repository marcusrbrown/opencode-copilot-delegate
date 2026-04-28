import { spawn } from 'node:child_process'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { isErrnoException } from '../lib/errno'

export interface ReapDeps {
  killProcessTree: (pid: number) => Promise<void>
  getPidIdentity: (
    pid: number,
  ) => Promise<{ comm: string; lstart: string } | null>
  isPluginAlive: (pid: number) => boolean
}

export interface ReapResult {
  reaped: number
  skipped: number
  scannedFiles: number
  deletedFiles: number
}

export function defaultIsPluginAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return isErrnoException(e) && e.code === 'EPERM'
  }
}

/**
 * Spawn `ps` with the given args, return trimmed stdout, or null on any
 * failure mode (timeout, spawn error, non-zero exit, empty output).
 *
 * Bounded 1-second SIGTERM timeout. Stderr is drained via resume() so the
 * OS pipe buffer never fills under backpressure — an unread stderr pipe on
 * a long-running or backlogged ps invocation can stall the subprocess and
 * block plugin init.
 */
function runPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', args)
    let stdout = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 1000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.resume()

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || code !== 0) {
        resolve(null)
      } else {
        const trimmed = stdout.trim()
        resolve(trimmed || null)
      }
    })

    child.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })
  })
}

/**
 * Read both comm (kernel-tracked executable name) and lstart (process
 * start time) for a PID via a single ps invocation.
 *
 * Halves the fork/exec cost of identity verification compared with two
 * separate `ps -o comm=` and `ps -o lstart=` calls. The combined output
 * format is `<comm> <lstart>` where comm is a single token and lstart is
 * a multi-word date string (e.g., `Tue Apr 28 23:45:30 2026`).
 *
 * Returns null on any failure mode (timeout, spawn error, non-zero exit,
 * empty output, malformed output). Callers must treat null as "identity
 * unverifiable; do not trust this PID."
 */
export async function getPidIdentity(
  pid: number,
): Promise<{ comm: string; lstart: string } | null> {
  const raw = await runPs(['-p', String(pid), '-o', 'comm=,lstart='])
  if (raw === null) return null
  const firstWs = raw.search(/\s/)
  if (firstWs === -1) return null
  const comm = raw.slice(0, firstWs)
  const lstart = raw.slice(firstWs).trim()
  if (!comm || !lstart) return null
  return { comm, lstart }
}

interface PidEntry {
  pid: number
  comm: string
  lstart: string
}

function parseLine(line: string): PidEntry | null {
  const parts = line.split('\t')
  if (parts.length !== 3) return null
  const pidStr = parts[0]
  // Strict integer parse: rejects negative, zero, decimal, and partial parses
  // like '1234abc' that parseInt would silently accept.
  if (!/^[1-9]\d*$/.test(pidStr)) return null
  const pid = Number(pidStr)
  return { pid, comm: parts[1], lstart: parts[2] }
}

/**
 * Maximum concurrent ps probes during reap. A streaming worker pool of
 * this size drains the entry queue without head-of-line blocking: a slow
 * probe in one worker doesn't stall the others.
 */
const MAX_CONCURRENT_PROBES = 5

async function processEntry(
  entry: PidEntry,
  killProcessTree: ReapDeps['killProcessTree'],
  getPidIdentity: ReapDeps['getPidIdentity'],
): Promise<{ reaped: boolean; skipped: boolean }> {
  try {
    process.kill(entry.pid, 0)
  } catch {
    return { reaped: false, skipped: true }
  }

  const live = await getPidIdentity(entry.pid)

  if (
    live === null ||
    live.comm !== entry.comm ||
    live.lstart !== entry.lstart
  ) {
    return { reaped: false, skipped: true }
  }

  try {
    await killProcessTree(entry.pid)
    return { reaped: true, skipped: false }
  } catch {
    return { reaped: false, skipped: true }
  }
}

async function processEntries(
  entries: PidEntry[],
  killProcessTree: ReapDeps['killProcessTree'],
  getPidIdentity: ReapDeps['getPidIdentity'],
): Promise<{ reaped: number; skipped: number }> {
  let reaped = 0
  let skipped = 0

  // Streaming worker pool: spawn up to MAX_CONCURRENT_PROBES workers that
  // drain a shared queue independently. Each worker pulls the next entry,
  // processes it, and loops until the queue is empty. A slow probe blocks
  // only its own worker; the other workers keep making progress.
  //
  // Single-threaded JS guarantees `queue.shift()` is atomic: there is no
  // window between the length check and the shift where another worker
  // can interleave.
  const queue = [...entries]
  const workerCount = Math.min(MAX_CONCURRENT_PROBES, entries.length)
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const entry = queue.shift()
      if (!entry) return
      const result = await processEntry(entry, killProcessTree, getPidIdentity)
      if (result.reaped) reaped++
      else if (result.skipped) skipped++
    }
  })

  await Promise.all(workers)

  return { reaped, skipped }
}

async function readPidFileEntries(
  filePath: string,
): Promise<PidEntry[] | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const entries: PidEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const entry = parseLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

async function cleanupAfterReap(
  filePath: string,
  isCurrent: boolean,
  currentInstancePath: string,
): Promise<boolean> {
  try {
    if (isCurrent) {
      await writeFile(currentInstancePath, '')
      return false
    }
    await unlink(filePath)
    return true
  } catch {
    return false
  }
}

interface ReapFileOutcome {
  reaped: number
  skipped: number
  scanned: boolean
  deleted: boolean
}

async function reapOneFile(
  filePath: string,
  filePid: number,
  isCurrent: boolean,
  currentInstancePath: string,
  isPluginAlive: ReapDeps['isPluginAlive'],
  killProcessTree: ReapDeps['killProcessTree'],
  getPidIdentity: ReapDeps['getPidIdentity'],
): Promise<ReapFileOutcome> {
  const empty: ReapFileOutcome = {
    reaped: 0,
    skipped: 0,
    scanned: false,
    deleted: false,
  }

  if (!isCurrent && isPluginAlive(filePid)) {
    return empty
  }

  const entries = await readPidFileEntries(filePath)
  if (entries === null) {
    return empty
  }

  const { reaped, skipped } = await processEntries(
    entries,
    killProcessTree,
    getPidIdentity,
  )
  const deleted = await cleanupAfterReap(
    filePath,
    isCurrent,
    currentInstancePath,
  )
  return { reaped, skipped, scanned: true, deleted }
}

export async function reapOrphans(opts: {
  pidFileDir: string
  currentInstancePath: string
  killProcessTree: ReapDeps['killProcessTree']
  getPidIdentity: ReapDeps['getPidIdentity']
  isPluginAlive?: ReapDeps['isPluginAlive']
}): Promise<ReapResult> {
  const {
    pidFileDir,
    currentInstancePath,
    killProcessTree,
    getPidIdentity,
    isPluginAlive = defaultIsPluginAlive,
  } = opts

  let files: string[]
  try {
    files = await readdir(pidFileDir)
  } catch {
    return { reaped: 0, skipped: 0, scannedFiles: 0, deletedFiles: 0 }
  }

  let reaped = 0
  let skipped = 0
  let scannedFiles = 0
  let deletedFiles = 0

  for (const file of files) {
    if (!file.endsWith('.pids')) continue

    const filePath = join(pidFileDir, file)
    const stem = basename(file, extname(file))
    // Strict integer parse: filename stem must be a positive integer; reject
    // negative, zero, decimal, and partial-parse oddities like '1234abc'.
    if (!/^[1-9]\d*$/.test(stem)) {
      console.warn(`[orphan-reaper] Skipping non-numeric PID file: ${file}`)
      continue
    }
    const filePid = Number(stem)

    const outcome = await reapOneFile(
      filePath,
      filePid,
      filePid === process.pid,
      currentInstancePath,
      isPluginAlive,
      killProcessTree,
      getPidIdentity,
    )

    reaped += outcome.reaped
    skipped += outcome.skipped
    if (outcome.scanned) scannedFiles++
    if (outcome.deleted) deletedFiles++
  }

  return { reaped, skipped, scannedFiles, deletedFiles }
}
