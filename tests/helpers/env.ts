/**
 * Environment helpers for tests.
 *
 * `process.env.X = undefined` stores the string "undefined" under Bun, so
 * restoring a variable that was originally unset must `delete` it instead.
 */

export type EnvValues = Record<string, string | undefined>

/** Set `key` to `value`, or delete it when `value` is undefined. */
export function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

/**
 * Snapshot the current values of `keys`, apply `overrides` (undefined deletes),
 * and return a function that restores every key in `keys` to its snapshot,
 * deleting those that were originally unset.
 */
export function overrideEnv(
  keys: readonly string[],
  overrides: EnvValues = {},
): () => void {
  const saved: EnvValues = {}
  for (const key of keys) {
    saved[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    setEnv(key, value)
  }
  return () => {
    for (const key of keys) {
      setEnv(key, saved[key])
    }
  }
}
