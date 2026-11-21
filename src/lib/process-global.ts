/**
 * Process-wide state shared by every module instance of this plugin.
 *
 * OpenCode can evaluate the plugin module more than once in one process: once
 * per config source, and (since #530 item 2) once per workspace directory. A
 * module-level `new Map()` therefore exists once per module instance, not once
 * per process. State that must be process-wide lives on `globalThis` under a
 * `Symbol.for` key, so every instance resolves the same object. Examples are
 * the task registry the RPC server lists, the PID-ledger write lock, and the
 * per-session in-flight counters.
 *
 * Keys are versioned (`.v1`). If a stored shape changes incompatibly, bump
 * the version so two plugin versions loaded in one process don't share state.
 */

type GlobalSlots = typeof globalThis & Record<symbol, unknown>

function slotKey(name: string): symbol {
  return Symbol.for(`opencode-copilot-delegate.${name}.v1`)
}

/** Return the process-wide value for `name`, creating it with `init` once. */
export function processGlobal<T>(name: string, init: () => T): T {
  const g = globalThis as GlobalSlots
  const key = slotKey(name)
  if (!(key in g)) {
    g[key] = init()
  }
  return g[key] as T
}

/** Test-only: forget a process-wide slot so the next access re-creates it. */
export function _resetProcessGlobal(name: string): void {
  delete (globalThis as GlobalSlots)[slotKey(name)]
}
