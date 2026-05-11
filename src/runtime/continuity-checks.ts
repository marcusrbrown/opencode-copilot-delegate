import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isErrnoException } from '../lib/errno'

const copilotSessionUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function normalizeContinuityError(stderr: string): string | null {
  const match = stderr.match(
    /^Error: No session, task, or name matched '(.+)'/m,
  )
  if (!match) return null
  return `No session, task, or name matched '${match[1]}'`
}

export function resolveConfigDir(explicit?: string): string {
  return resolve(
    explicit ?? process.env.COPILOT_CONFIG_DIR ?? join(homedir(), '.copilot'),
  )
}

export function isCopilotSessionUuid(value: string): boolean {
  return copilotSessionUuidPattern.test(value)
}

export async function hasLocalCopilotSession(
  uuid: string,
  configDir: string,
): Promise<boolean> {
  const sessionStateDir = resolve(configDir, 'session-state')
  const sessionDbPath = resolve(sessionStateDir, uuid, 'session.db')

  if (!isWithin(sessionDbPath, sessionStateDir)) {
    return false
  }

  try {
    const stats = await stat(sessionDbPath)
    return stats.isFile()
  } catch (e) {
    if (isErrnoException(e) && e.code === 'ENOENT') return false
    throw e
  }
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  )
}
