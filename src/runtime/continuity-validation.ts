import { isAbsolute, resolve, sep } from 'node:path'

type TargetId = { type: 'uuid' | 'name'; value: string }
type ValidationError = { error: string }

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const namePattern = /^[A-Za-z0-9._-]{1,128}$/

export function validateTargetId(value: string): TargetId | ValidationError {
  if (uuidPattern.test(value)) return { type: 'uuid', value }
  if (namePattern.test(value)) return { type: 'name', value }
  return { error: 'invalid target ID format' }
}

export function validateAddDirs(
  values: string[],
  allowedRoots: string[],
): string[] | ValidationError {
  if (values.length > 32) return { error: 'too many addDirs' }

  const resolved: string[] = []
  for (const value of values) {
    if (value.startsWith('--')) {
      return { error: 'argv-injection-shaped value in addDirs' }
    }

    const path = validatePathUnderAllowedRoots(value, allowedRoots)
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

  const path = validatePathUnderAllowedRoots(value, allowedRoots)
  if (!path) return { error: 'cwd outside allowed roots' }
  return path
}

function validatePathUnderAllowedRoots(
  value: string,
  allowedRoots: string[],
): string | null {
  if (!isAbsolute(value)) return null

  const path = resolve(value)
  if (allowedRoots.some((root) => isWithin(path, root))) return path
  return null
}

function isWithin(path: string, root: string): boolean {
  const resolvedPath = resolve(path)
  const resolvedRoot = resolve(root)
  return (
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${sep}`)
  )
}
