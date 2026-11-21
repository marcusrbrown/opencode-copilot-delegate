import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isErrnoException } from '../lib/errno'
import { defaultIsPluginAlive } from './orphan-reaper'

/**
 * Best-effort sweep of port files left behind by exited hosts.
 *
 * `close()` only runs on `beforeExit`/SIGTERM, so a host that dies any other
 * way (SIGKILL, crash, torn-down worker) leaves `<base>/<discriminator>/
 * server-port.json` behind. When the discriminator is the PID it is never
 * revisited, so the files accumulate forever. This sweep removes sibling
 * files that are provably stale and otherwise fails closed.
 *
 * The sweep is discriminator-agnostic: it never assumes what a directory name
 * means beyond "all digits may be a PID", and it identifies the writer from
 * the `pid` recorded in the file. Token values are never logged or retained.
 */

export const DEFAULT_PORT_FILE_GRACE_MS = 10 * 60 * 1000
export const DEFAULT_PORT_SWEEP_MAX_ENTRIES = 256

const PORT_FILE_NAME = 'server-port.json'

export type PortFileSweepOptions = {
  baseDir: string
  /** Directory name of the running server. It is never touched. */
  currentDiscriminator: string
  now?: () => number
  /** Minimum file age (mtime) before removal. Default 10 minutes. */
  graceMs?: number
  /** Max directory entries examined per sweep. Default 256. */
  maxEntries?: number
  /** PID liveness probe. Default: `process.kill(pid, 0)`. */
  isPidAlive?: (pid: number) => boolean
}

export type PortFileSweepResult = {
  scanned: number
  removed: number
  kept: number
}

type PidDecision = { kind: 'pid'; pid: number } | { kind: 'ambiguous' }

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function numericDirectoryPid(entry: string): number | undefined {
  if (!/^[1-9][0-9]{0,9}$/.test(entry)) return undefined
  const pid = Number(entry)
  return Number.isSafeInteger(pid) ? pid : undefined
}

/**
 * Resolve the writer PID without exposing the token: only `pid` is read from
 * the parsed object, and the object is dropped immediately.
 */
function decidePid(contents: string, entry: string): PidDecision {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return { kind: 'ambiguous' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'ambiguous' }
  }

  const recorded = (parsed as Record<string, unknown>).pid
  const directoryPid = numericDirectoryPid(entry)

  if (recorded === undefined) {
    // No PID recorded: the directory name must identify it.
    return directoryPid === undefined
      ? { kind: 'ambiguous' }
      : { kind: 'pid', pid: directoryPid }
  }

  if (!isPositiveInteger(recorded)) return { kind: 'ambiguous' }

  // A numeric directory that disagrees with the recorded PID is ambiguous.
  if (directoryPid !== undefined && directoryPid !== recorded) {
    return { kind: 'ambiguous' }
  }

  return { kind: 'pid', pid: recorded }
}

async function sweepEntry(
  baseDir: string,
  entry: string,
  nowMs: number,
  graceMs: number,
  isPidAlive: (pid: number) => boolean,
): Promise<boolean> {
  const dirPath = join(baseDir, entry)
  const filePath = join(dirPath, PORT_FILE_NAME)

  // lstat (no symlink following) for both the directory and the file.
  const dirStat = await lstat(dirPath)
  if (!dirStat.isDirectory()) return false

  let fileStat: Awaited<ReturnType<typeof lstat>>
  try {
    fileStat = await lstat(filePath)
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
    // No port file: an emptied directory left by a clean `close()` on an
    // older build, or by a crash between mkdir and write. Once it is past
    // the grace window, remove it so it stops using a sweep slot on every
    // start. Non-recursive: anything still inside (for example an orphaned
    // temp file) makes rmdir fail and keeps the directory.
    if (nowMs - dirStat.mtimeMs < graceMs) return false
    await rmdir(dirPath)
    return true
  }
  if (!fileStat.isFile()) return false

  if (nowMs - fileStat.mtimeMs < graceMs) return false

  const decision = decidePid(await readFile(filePath, 'utf8'), entry)
  if (decision.kind !== 'pid') return false

  if (isPidAlive(decision.pid)) return false

  await rm(filePath, { force: true })
  // Non-recursive: only succeeds when the directory is now empty.
  await rmdir(dirPath).catch(() => {})
  return true
}

/**
 * Remove stale `server-port.json` files (and their emptied directories) from
 * sibling discriminator directories. Never throws; any per-entry error leaves
 * that entry untouched.
 */
export async function sweepStalePortFiles(
  options: PortFileSweepOptions,
): Promise<PortFileSweepResult> {
  const result: PortFileSweepResult = { scanned: 0, removed: 0, kept: 0 }

  try {
    const now = options.now ?? Date.now
    const graceMs = options.graceMs ?? DEFAULT_PORT_FILE_GRACE_MS
    const maxEntries = options.maxEntries ?? DEFAULT_PORT_SWEEP_MAX_ENTRIES
    const isPidAlive = options.isPidAlive ?? defaultIsPluginAlive

    const entries = (await readdir(options.baseDir)).filter(
      (entry) => entry !== options.currentDiscriminator,
    )

    for (const entry of entries.slice(0, Math.max(0, maxEntries))) {
      result.scanned += 1
      try {
        if (
          await sweepEntry(options.baseDir, entry, now(), graceMs, isPidAlive)
        ) {
          result.removed += 1
        } else {
          result.kept += 1
        }
      } catch {
        // Fail closed: any error or ambiguity leaves the entry in place.
        result.kept += 1
      }
    }
  } catch {
    // Unreadable base directory (or a throwing injected dependency): nothing
    // to sweep. Best-effort by contract.
  }

  return result
}
