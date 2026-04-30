/**
 * Per-process singleton guard for the plugin factory.
 *
 * OpenCode invokes the plugin factory more than once per process when the
 * same plugin is referenced by multiple config sources (for example a
 * user-level `~/.config/opencode/opencode.json` AND a project-level
 * `opencode.json`). Each invocation evaluates the plugin module fresh —
 * module-local variables reset between calls — so the singleton state
 * must live on `globalThis` to persist across module instances within
 * the same process.
 *
 * On the first invocation the init runs normally and the resulting hooks
 * promise is cached on `globalThis`. On subsequent invocations within
 * the same PID the cached promise is returned and `onDuplicate` is
 * invoked exactly once (subsequent duplicates are silent so logs do not
 * spam). Across PIDs the singleton is treated as absent and init runs
 * fresh — `globalThis` is per-process, but the explicit PID guard adds
 * defensive belt-and-suspenders against any state-leakage edge case.
 *
 * The cached value is the init Promise rather than the resolved value so
 * a second invocation that arrives while the first is still awaiting
 * `mkdir` / `reapOrphans` converges on the same init result instead of
 * starting a parallel init.
 *
 * **Known limitation — rejected init is cached.** If `doInit()` rejects,
 * the rejected promise is stored on `globalThis` and every subsequent
 * invocation in the same PID returns the same rejection without
 * retrying init. This is intentional: re-running heavy init on every
 * call would defeat the singleton's purpose. Recovery requires a
 * process restart. OpenCode currently surfaces a failed plugin factory
 * as a startup error rather than retrying within the process, so this
 * matches the upstream contract.
 */

const SINGLETON_KEY: unique symbol = Symbol.for(
  'opencode-copilot-delegate.singleton.v1',
)

interface SingletonState<T> {
  pid: number
  loadedAt: number
  hooksPromise: Promise<T>
  warned: boolean
}

/**
 * Type-safe view onto `globalThis` for our symbol-keyed singleton slot.
 *
 * TypeScript's `declare global { var ... }` augmentation does not accept
 * computed property keys, so a unique-symbol-keyed slot on `globalThis`
 * is reachable only via an intersection cast. The cast is contained at
 * a single point (`globalThis as unknown as GlobalWithSingleton<T>`)
 * and the property type drives subsequent reads and writes — callers do
 * not re-assert the value's shape with additional casts.
 */
type GlobalWithSingleton<T> = typeof globalThis & {
  [SINGLETON_KEY]?: SingletonState<T>
}

export interface PlugInOnceOptions<T> {
  /** Heavy init work that should run at most once per process. */
  doInit: () => Promise<T>
  /**
   * Called exactly once on the first duplicate invocation in the same
   * process. Subsequent duplicates are silent. Receives the same `pid`
   * value the guard used for its identity check (so test overrides flow
   * through faithfully). Implementations must not throw; fire-and-forget
   * side effects (logging, metrics) are expected. Synchronous exceptions
   * are swallowed defensively.
   */
  onDuplicate?: (pid: number) => void
  /** Test override; defaults to `process.pid`. */
  pid?: number
}

/**
 * Run `doInit` at most once per process, returning the cached hooks
 * promise on subsequent invocations within the same PID.
 */
export async function plugInOnce<T>({
  doInit,
  onDuplicate,
  pid,
}: PlugInOnceOptions<T>): Promise<T> {
  const currentPid = pid ?? process.pid
  const g = globalThis as unknown as GlobalWithSingleton<T>
  const existing = g[SINGLETON_KEY]

  if (existing && existing.pid === currentPid) {
    if (!existing.warned) {
      existing.warned = true
      try {
        onDuplicate?.(currentPid)
      } catch {
        // onDuplicate must not block plugin init.
      }
    }
    return existing.hooksPromise
  }

  const hooksPromise = doInit()
  g[SINGLETON_KEY] = {
    pid: currentPid,
    loadedAt: Date.now(),
    hooksPromise,
    warned: false,
  }
  return hooksPromise
}

/**
 * Test-only: clear the singleton state so the next invocation re-runs
 * init. Must not be called in production code paths.
 */
export function _resetPluginSingleton(): void {
  const g = globalThis as unknown as GlobalWithSingleton<unknown>
  delete g[SINGLETON_KEY]
}
