import { realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { isCopilotSessionUuid } from './continuity-checks'

type TargetId = { type: 'uuid' | 'name'; value: string }
type ValidationError = { error: string }

const namePattern = /^[A-Za-z0-9._-]{1,128}$/

export function validateTargetId(value: string): TargetId | ValidationError {
  if (value.startsWith('cpl_')) {
    return {
      error:
        'Plugin task IDs (cpl_*) are not valid resume targets. Use copilot_output(task_id) to retrieve results, or pass the copilot_session_id from the completed task envelope.',
    }
  }
  if (isCopilotSessionUuid(value))
    return { type: 'uuid', value: value.toLowerCase() }
  if (namePattern.test(value)) return { type: 'name', value }
  return { error: 'invalid target ID format' }
}

export function validateAddDirs(
  values: string[],
  allowedRoots: string[],
): string[] | ValidationError {
  if (values.length > 32) return { error: 'too many addDirs' }

  const canonicalRoots = canonicalizeRoots(allowedRoots)
  const resolved: string[] = []
  for (const value of values) {
    if (value.startsWith('--')) {
      return { error: 'argv-injection-shaped value in addDirs' }
    }

    const path = validatePathUnderAllowedRoots(value, canonicalRoots)
    if (!path) return { error: 'path outside allowed roots' }
    resolved.push(path)
  }

  return resolved
}

export function validateCwd(
  value: string,
  allowedRoots: string[],
): string | ValidationError {
  if (value.startsWith('--')) return { error: 'argv-injection-shaped cwd' }

  const canonicalRoots = canonicalizeRoots(allowedRoots)
  const path = validatePathUnderAllowedRoots(value, canonicalRoots)
  if (!path) return { error: 'cwd outside allowed roots' }
  return path
}

/**
 * Canonicalize allowed roots via realpath so symlink-based escape attempts
 * in candidate paths are caught when we compare real paths.
 */
function canonicalizeRoots(roots: string[]): string[] {
  return roots.flatMap((r) => {
    const real = tryRealpath(resolve(r))
    return real !== null ? [real] : []
  })
}

/**
 * Resolve a candidate path against canonicalized allowed roots.
 * Uses realpath to follow symlinks — a symlink inside an allowed root that
 * points outside will resolve to a real path outside and be rejected.
 * Falls back to `resolve()` when the path does not exist (ENOENT).
 * Returns null (→ rejected) on any other realpath error (ELOOP, EACCES, …).
 */
function validatePathUnderAllowedRoots(
  value: string,
  canonicalRoots: string[],
): string | null {
  if (!isAbsolute(value)) return null

  const real = tryRealpath(resolve(value))
  if (real === null) return null
  if (canonicalRoots.some((root) => isWithin(real, root))) return real
  return null
}

/**
 * realpath with ENOENT fallback to resolve(), null on any other error.
 * Returning null signals the caller to treat the path as unresolvable and
 * reject it — covers ELOOP (symlink cycles), EACCES, ENOTDIR, etc.
 */
function tryRealpath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch (e) {
    if (
      e instanceof Error &&
      'code' in e &&
      (e as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return path
    }
    return null
  }
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}
