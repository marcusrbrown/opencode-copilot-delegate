import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { wireRpcServerCleanup } from '../src/lib/rpc-cleanup'

describe('wireRpcServerCleanup', () => {
  let originalBeforeExitListeners: NodeJS.BeforeExitListener[]
  let originalSigtermListeners: NodeJS.SignalsListener[]

  beforeEach(() => {
    // Snapshot pre-existing listeners so afterEach can detect and clean up
    // any registered by the test itself. The plugin keeps its own listeners
    // alive for the lifetime of `tests/index.test.ts`'s singletons; we only
    // want to scrub the ones THIS test added.
    originalBeforeExitListeners = [
      ...(process.listeners('beforeExit') as NodeJS.BeforeExitListener[]),
    ]
    originalSigtermListeners = [
      ...(process.listeners('SIGTERM') as NodeJS.SignalsListener[]),
    ]
  })

  afterEach(() => {
    for (const listener of process.listeners('beforeExit')) {
      if (
        !originalBeforeExitListeners.includes(
          listener as NodeJS.BeforeExitListener,
        )
      ) {
        process.off('beforeExit', listener as NodeJS.BeforeExitListener)
      }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (
        !originalSigtermListeners.includes(listener as NodeJS.SignalsListener)
      ) {
        process.off('SIGTERM', listener as NodeJS.SignalsListener)
      }
    }
  })

  it('returns an idempotent closeOnce that invokes closeRpcServer exactly once across repeated direct calls', async () => {
    let callCount = 0
    const closeRpcServer = async () => {
      callCount += 1
    }

    const closeOnce = wireRpcServerCleanup(closeRpcServer)

    await closeOnce()
    await closeOnce()
    await closeOnce()

    expect(callCount).toBe(1)
  })

  it('invokes closeRpcServer exactly once even if beforeExit fires multiple times synchronously before the close promise settles', async () => {
    let callCount = 0
    // A close that takes a tick to resolve — gives beforeExit re-entrancy
    // (if any) a chance to slip in before `closePromise` is assigned.
    const closeRpcServer = (): Promise<void> => {
      return new Promise((resolve) => {
        setTimeout(() => {
          callCount += 1
          resolve()
        }, 5)
      })
    }

    wireRpcServerCleanup(closeRpcServer)

    // Find the listener this call just installed and fire it three times
    // synchronously. With `process.once` the second/third emit is a no-op
    // because Node removes the wrapper after the first invocation. The fix
    // (`process.once` for both events, not just SIGTERM) ensures
    // `callCount` cannot exceed 1 regardless of how `beforeExit` re-fires.
    const installedListeners = process
      .listeners('beforeExit')
      .filter(
        (l) =>
          !originalBeforeExitListeners.includes(l as NodeJS.BeforeExitListener),
      )

    expect(installedListeners).toHaveLength(1)
    const installed = installedListeners[0] as NodeJS.BeforeExitListener

    process.emit('beforeExit', 0)
    process.emit('beforeExit', 0)
    process.emit('beforeExit', 0)

    // Wait for the close promise to settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    expect(callCount).toBe(1)

    // The `process.once` semantics mean the listener is gone after the first
    // emit. If `process.on` had been used, the listener would still be
    // registered here — that was the pre-fix shape.
    expect(process.listeners('beforeExit')).not.toContain(installed)
  })
})
