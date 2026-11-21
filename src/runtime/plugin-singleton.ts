/**
 * Register-once guards for the plugin factory.
 *
 * OpenCode invokes the plugin factory more than once per process: once per
 * config source that lists the plugin (for example a user-level
 * `~/.config/opencode/opencode.json` AND a project-level `opencode.json`),
 * and once per workspace directory the server opens. Each invocation may
 * evaluate the plugin module fresh, so module-local variables reset between
 * calls. The guard state therefore lives on `globalThis` to persist across
 * module instances within the same process.
 *
 * Two guards with different scopes:
 *
 * - `acquireProcessCore` (src/runtime/process-core.ts) runs process-wide
 *   setup (orphan reaping, the RPC server and its port file) once per live
 *   generation, whatever the directory. V1 never releases it.
 * - {@link plugInOnce} hands out real hooks once per `key` (the workspace
 *   directory). A second invocation for the same key gets `{}`; a different
 *   key gets its own real hooks. This partially supersedes R6 of the
 *   2026-05-11 singleton decision, which returned `{}` to every invocation
 *   after the first. That starved later workspaces of tools (#530 item 2).
 *
 * For a given key, the first invocation runs `doInit` and caches its promise
 * on `globalThis`; the caller receives `{ isFirst: true, hooks }`. Every
 * later invocation for that key in the same PID skips `doInit`, awaits the
 * cached promise (so sticky rejections still propagate), fires `onDuplicate`
 * once, and receives `{ isFirst: false, hooks: {} as T }`. Across PIDs the
 * guard is treated as absent and init runs fresh. `globalThis` is
 * per-process, but the explicit PID check is a defensive belt-and-suspenders
 * against any state-leakage edge case.
 *
 * **Why empty hooks on duplicate invocations.**
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
 * This plugin's process setup is not idempotent. The RPC server binds an
 * ephemeral port and writes a port file with a fresh bearer token to a
 * well-known path. A second server in the same process would not collide on
 * the port (it is port 0, so the OS picks a new one). It would overwrite the
 * port file, though, so the TUI would discover only the second server and its
 * token, and lose sight of tasks the first one serves. Orphan reaping must
 * also run once, before any task is spawned. `acquireProcessCore` is the
 * guard for that process-wide work. Per-directory tool hooks are cheap and
 * safe to build once per workspace. The paired `wireRpcServerCleanup` helper
 * in `src/lib/rpc-cleanup.ts` enforces the matching invariant on shutdown:
 * the server closes exactly once.
 */

import { _resetProcessGlobal, processGlobal } from '../lib/process-global'
import { _resetProcessCore } from './process-core'

// Not 'singleton': that `.v1` slot held a single state object in releases
// before per-directory hooks, and a Map here would collide with it if both
// versions load in one process.
const HOOKS_SLOT = 'hook-guards'
const DEFAULT_KEY = '<default>'

interface SingletonState<T> {
  pid: number
  loadedAt: number
  hooksPromise: Promise<T>
  warned: boolean
}

/** Per-key hook guards, shared by every module instance in the process. */
function hookGuards(): Map<string, SingletonState<unknown>> {
  return processGlobal(
    HOOKS_SLOT,
    () => new Map<string, SingletonState<unknown>>(),
  )
}

export interface PlugInOnceOptions<T> {
  /** Per-key hook construction; runs at most once per key per process. */
  doInit: () => Promise<T>
  /**
   * Guard key. Use the workspace directory so each workspace gets its own
   * hooks while repeat invocations for one workspace get `{}`. Defaults to a
   * single shared key (the pre-#530 one-hooks-per-process behavior).
   */
  key?: string
  /**
   * Called exactly once on the first duplicate invocation for a key in the
   * same process. Subsequent duplicates are silent. Receives the same `pid`
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
 * Run `doInit` at most once per `key` per process; on duplicate invocations
 * for the same key resolve to empty hooks so the OpenCode host does not
 * double-register tools and hooks under dual-source configurations.
 */
export async function plugInOnce<T>({
  doInit,
  key = DEFAULT_KEY,
  onDuplicate,
  pid,
}: PlugInOnceOptions<T>): Promise<PlugInOnceResult<T>> {
  const currentPid = pid ?? process.pid
  const guards = hookGuards()
  const existing = guards.get(key)

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
  guards.set(key, {
    pid: currentPid,
    loadedAt: Date.now(),
    hooksPromise,
    warned: false,
  })
  const hooks = await hooksPromise
  return { isFirst: true, hooks }
}

/**
 * Test-only: clear the hook guards and the process core so the next
 * invocation re-runs process setup and hook construction. Must not be called
 * in production code paths.
 */
export function _resetPluginSingleton(): void {
  _resetProcessGlobal(HOOKS_SLOT)
  _resetProcessCore()
}
