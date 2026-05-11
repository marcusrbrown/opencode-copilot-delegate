/**
 * Per-process register-once guard for the plugin factory.
 *
 * OpenCode invokes the plugin factory more than once per process when the
 * same plugin is referenced by multiple config sources (for example a
 * user-level `~/.config/opencode/opencode.json` AND a project-level
 * `opencode.json`). Each invocation evaluates the plugin module fresh —
 * module-local variables reset between calls — so the guard state must
 * live on `globalThis` to persist across module instances within the
 * same process.
 *
 * On the first invocation `doInit` runs and the resulting hooks promise
 * is cached on `globalThis`; the caller receives `{ isFirst: true, hooks }`.
 * On every subsequent invocation in the same PID `doInit` is skipped, the
 * cached promise is awaited (so sticky rejections still propagate),
 * `onDuplicate` fires exactly once, and the caller receives
 * `{ isFirst: false, hooks: {} as T }`. Across PIDs the guard is treated
 * as absent and init runs fresh — `globalThis` is per-process, but the
 * explicit PID check adds defensive belt-and-suspenders against any
 * state-leakage edge case.
 *
 * **Why empty hooks on duplicate invocations.** A whole-hooks singleton
 * that returns the same hooks reference to both invocations does not
 * deduplicate host-side tool registration: OpenCode iterates each plugin
 * source's returned hook surface and registers every tool entry it finds,
 * even when two sources return the same JS reference. Returning `{}` from
 * the duplicate path is the only shape that prevents host-side double
 * registration of `copilot_delegate`, `copilot_output`, and
 * `copilot_cancel`. Verified empirically against
 * `client.tool.list({...})`: under whole-hooks reuse a dual-source config
 * lists each tool twice; under empty-hooks-on-duplicate it lists each
 * tool once.
 *
 * The cached value is the init Promise rather than the resolved value so
 * a second invocation that arrives while the first is still awaiting
 * `mkdir` / `reapOrphans` converges on the same init result instead of
 * starting a parallel init.
 *
 * **Known limitation — rejected init is sticky.** If `doInit()` rejects,
 * the rejected promise is stored on `globalThis` and every subsequent
 * invocation in the same PID surfaces the same rejection without
 * retrying init. This is intentional: re-running heavy init on every
 * call would defeat the guard's purpose. Recovery requires a process
 * restart. OpenCode currently surfaces a failed plugin factory as a
 * startup error rather than retrying within the process, so this matches
 * the upstream contract.
 *
 * **Why this plugin keeps the singleton pattern when Systematic dropped it.**
 * Systematic's PR #352 (https://github.com/marcusrbrown/systematic/pull/352,
 * shipped in v2.12.1/v2.12.2) replaced `plugInOnce` with per-load
 * registration guarded by a marker flag. That change was correct for
 * Systematic: its plugins are stateless and idempotent — they register
 * tools and inject prompts, but they do not bind ports or write PID files.
 * Running the same Systematic plugin factory twice in the same process is
 * harmless because the second run produces the same registrations as the
 * first.
 *
 * This plugin's init is not idempotent. `doInit` starts an RPC server that
 * binds a TCP port and writes a PID file to a well-known path. A second
 * `doInit` call in the same process would attempt to bind the same port
 * (EADDRINUSE) and overwrite the PID file with a duplicate entry. The
 * singleton pattern is the correct constraint here: exactly one server
 * starts per process, and exactly one PID file entry is written. The
 * paired `wireRpcServerCleanup` helper in `src/lib/rpc-cleanup.ts`
 * enforces the matching invariant on shutdown — the server closes exactly
 * once. Both guards exist because the resource is exclusive to the process.
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
 * Result envelope for `plugInOnce(...)`.
 *
 * - `isFirst: true` — caller should return `hooks` (the real hooks from
 *   `doInit`) to OpenCode.
 * - `isFirst: false` — caller MUST return `hooks` (which is an empty `{}`)
 *   so the host loader does not register tools or hooks twice.
 *
 * Callers that just `return result.hooks` do the right thing in both
 * cases without needing to inspect `isFirst` — the empty object is what
 * the host should register on the duplicate source.
 */
export interface PlugInOnceResult<T> {
  isFirst: boolean
  hooks: T
}

/**
 * Run `doInit` at most once per process; on duplicate invocations resolve
 * to empty hooks so the OpenCode host does not double-register tools and
 * hooks under dual-source configurations.
 */
export async function plugInOnce<T>({
  doInit,
  onDuplicate,
  pid,
}: PlugInOnceOptions<T>): Promise<PlugInOnceResult<T>> {
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
    // Await the cached init so sticky rejections still propagate to the
    // duplicate caller. The resolved value is intentionally discarded —
    // duplicate callers receive empty hooks so the host registers nothing
    // for this source.
    await existing.hooksPromise
    return { isFirst: false, hooks: {} as T }
  }

  const hooksPromise = doInit()
  g[SINGLETON_KEY] = {
    pid: currentPid,
    loadedAt: Date.now(),
    hooksPromise,
    warned: false,
  }
  const hooks = await hooksPromise
  return { isFirst: true, hooks }
}

/**
 * Test-only: clear the singleton state so the next invocation re-runs
 * init. Must not be called in production code paths.
 */
export function _resetPluginSingleton(): void {
  const g = globalThis as unknown as GlobalWithSingleton<unknown>
  delete g[SINGLETON_KEY]
}
