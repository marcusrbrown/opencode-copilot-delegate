import { randomBytes } from 'node:crypto'
import {
  chmod,
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isErrnoException } from '../lib/errno'

// Per-file write serializer: maps each file path to the tail of its pending
// work chain. Each new write operation appends to this chain via .then(), so
// concurrent callers for the same path are sequenced without a mutex. Entries
// are deleted once the tail promise settles and no new work has been enqueued,
// preventing unbounded map growth over long-lived sessions.
const writeChains = new Map<string, Promise<void>>()

async function serializeWrite(
  filePath: string,
  work: () => Promise<void>,
): Promise<void> {
  const prev = writeChains.get(filePath) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(work)
  writeChains.set(filePath, next)
  try {
    await next
  } finally {
    if (writeChains.get(filePath) === next) {
      writeChains.delete(filePath)
    }
  }
}

export function resolveInstancePidFilePath(): string {
  const stateDir =
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  return join(
    stateDir,
    'opencode-copilot-delegate',
    'orphans',
    `${process.pid}.pids`,
  )
}

export async function appendPidEntry(
  filePath: string,
  pid: number,
  comm: string,
  lstart: string,
): Promise<void> {
  await serializeWrite(filePath, async () => {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })

    let existing = ''
    try {
      existing = await readFile(filePath, 'utf-8')
    } catch (e) {
      if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
    }

    const line = `${pid}\t${comm}\t${lstart}\n`
    const content = existing + line

    const tempPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`
    const fd = await open(
      tempPath,
      fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o600,
    )
    try {
      await fd.writeFile(content, { encoding: 'utf-8' })
    } finally {
      await fd.close()
    }

    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)
  })
}

export async function removePidEntry(
  filePath: string,
  pid: number,
): Promise<void> {
  await serializeWrite(filePath, async () => {
    let existing = ''
    try {
      existing = await readFile(filePath, 'utf-8')
    } catch (e) {
      if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
      return
    }

    const prefix = `${pid}\t`
    const lines = existing.split('\n')
    const filtered = lines.filter((line) => !line.startsWith(prefix))

    if (filtered.length === lines.length) {
      return
    }

    const content = filtered.join('\n')
    const tempPath = `${filePath}.tmp.${randomBytes(8).toString('hex')}`
    const fd = await open(
      tempPath,
      fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o600,
    )
    try {
      await fd.writeFile(content, { encoding: 'utf-8' })
    } finally {
      await fd.close()
    }

    await rename(tempPath, filePath)
    await chmod(filePath, 0o600)

    if (content.trim().length === 0) {
      await unlink(filePath)
    }
  })
}

/**
 * Truncate a PID file under the same per-file serialize lock used by
 * appendPidEntry/removePidEntry, so a concurrent writer cannot interleave
 * with the truncation. ENOENT is silently swallowed in both forms:
 * file-already-gone AND parent-directory-missing. Other errno values
 * propagate.
 */
export async function truncatePidFile(filePath: string): Promise<void> {
  await serializeWrite(filePath, async () => {
    try {
      await writeFile(filePath, '')
    } catch (e) {
      if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
    }
  })
}

/**
 * Remove a PID file under the same per-file serialize lock. ENOENT is
 * silently swallowed (file already gone). Other errno values propagate.
 */
export async function unlinkPidFile(filePath: string): Promise<void> {
  await serializeWrite(filePath, async () => {
    try {
      await unlink(filePath)
    } catch (e) {
      if (!isErrnoException(e) || e.code !== 'ENOENT') throw e
    }
  })
}
