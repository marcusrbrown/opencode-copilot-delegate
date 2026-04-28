/**
 * Type predicate that narrows `unknown` to `NodeJS.ErrnoException` for safe
 * `.code` access on errors thrown by `node:fs` and similar Node APIs.
 *
 * Use this in catch blocks instead of casting `e as NodeJS.ErrnoException`
 * — the cast is unsafe when the thrown value is a string, plain object, or
 * any non-Error type.
 */
export function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && 'code' in e
}
