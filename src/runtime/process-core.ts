import { _resetProcessGlobal, processGlobal } from '../lib/process-global'

/**
 * Reference-counted owner of the process-wide resources: orphan reap, the
 * RPC server and its port file, and the PID ledger.
 *
 * - V1 acquires on every factory call and never releases, so the resources
 *   live for the life of the process.
 * - V2 acquires in each location's `setup` and releases in its cleanup. The
 *   last release runs the teardown (cancel tasks, close RPC, truncate the
 *   ledger). The next acquire starts fresh resources: a new server, port
 *   file and token.
 *
 * Invariants (R5):
 * - Teardown runs once per resource generation, even when several locations
 *   release at once (V2 shutdown runs cleanups concurrently).
 * - Acquire waits for a pending teardown, so a release that the host doesn't
 *   await can't delete the next generation's port file.
 * - State lives on `globalThis`, because V2 re-evaluates the module for each
 *   location.
 */

export interface ProcessResources {
  pidFilePath: string
  /** Tear down this generation. Called once, by the last release. */
  teardown: () => Promise<void>
}

interface CoreState {
  refs: number
  resources?: Promise<ProcessResources>
  releasing?: Promise<void>
}

const SLOT = 'process-core'

function core(): CoreState {
  return processGlobal<CoreState>(SLOT, () => ({ refs: 0 }))
}

/**
 * Take a reference on the process resources, starting them with `init` if no
 * generation is live. `init` must not reject: setup failures are reported
 * inside it, and tools must still register.
 */
export async function acquireProcessCore(
  init: () => Promise<ProcessResources>,
): Promise<ProcessResources> {
  const state = core()
  while (state.releasing) {
    await state.releasing
  }
  state.refs += 1
  state.resources ??= init()
  return state.resources
}

/**
 * Drop a reference. The last one tears the generation down; the returned
 * promise settles when that teardown has finished. Extra releases are
 * ignored. The teardown never rejects.
 */
export function releaseProcessCore(): Promise<void> {
  const state = core()
  if (state.refs === 0) return state.releasing ?? Promise.resolve()
  state.refs -= 1
  if (state.refs > 0) return Promise.resolve()

  const resources = state.resources
  state.resources = undefined
  const releasing = (async () => {
    try {
      if (resources) await (await resources).teardown()
    } catch {
      // Teardown is best-effort; a failure must not wedge the next acquire.
    }
  })()
  const tracked = releasing.finally(() => {
    if (state.releasing === tracked) state.releasing = undefined
  })
  state.releasing = tracked
  return tracked
}

/** Test-only: forget all process-core state. */
export function _resetProcessCore(): void {
  _resetProcessGlobal(SLOT)
}
