import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetProcessCore,
  acquireProcessCore,
  type ProcessResources,
  releaseProcessCore,
} from '../src/runtime/process-core'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function generation(
  label: string,
  events: string[],
  teardownGate?: Promise<void>,
) {
  return async (): Promise<ProcessResources> => {
    events.push(`init ${label}`)
    return {
      pidFilePath: `/ledger/${label}`,
      teardown: async () => {
        events.push(`teardown ${label} begin`)
        await teardownGate
        events.push(`teardown ${label} end`)
      },
    }
  }
}

// Reset on both sides: other suites acquire through V1 (which never releases)
// and leave a live generation behind, and file order differs across runners.
beforeEach(() => {
  _resetProcessCore()
})

afterEach(() => {
  _resetProcessCore()
})

describe('process core acquire/release', () => {
  it('shares one generation across acquires and tears it down once on the last release', async () => {
    const events: string[] = []
    const first = await acquireProcessCore(generation('g1', events))
    const second = await acquireProcessCore(generation('unused', events))

    expect(second).toBe(first)

    await releaseProcessCore()
    expect(events).toEqual(['init g1'])

    await releaseProcessCore()
    expect(events).toEqual(['init g1', 'teardown g1 begin', 'teardown g1 end'])
  })

  it('tears down once when several locations release concurrently', async () => {
    const events: string[] = []
    await acquireProcessCore(generation('g1', events))
    await acquireProcessCore(generation('g1', events))
    await acquireProcessCore(generation('g1', events))

    await Promise.all([
      releaseProcessCore(),
      releaseProcessCore(),
      releaseProcessCore(),
      releaseProcessCore(), // an extra release is ignored
    ])

    expect(events.filter((e) => e.startsWith('teardown'))).toEqual([
      'teardown g1 begin',
      'teardown g1 end',
    ])
  })

  it('an acquire after an unawaited release waits for teardown, then starts a new generation', async () => {
    const events: string[] = []
    const gate = deferred()
    await acquireProcessCore(generation('g1', events, gate.promise))

    // When the release is not awaited and a new activation acquires at once
    void releaseProcessCore()
    const next = acquireProcessCore(generation('g2', events))
    await Promise.resolve()

    // Then the new generation has not started while teardown is pending
    expect(events).toEqual(['init g1', 'teardown g1 begin'])

    gate.resolve()
    const resources = await next

    // And it starts only after the old generation is fully torn down
    expect(events).toEqual([
      'init g1',
      'teardown g1 begin',
      'teardown g1 end',
      'init g2',
    ])
    expect(resources.pidFilePath).toBe('/ledger/g2')
  })

  it('a failing teardown does not wedge the next acquire', async () => {
    await acquireProcessCore(async () => ({
      pidFilePath: '/ledger/bad',
      teardown: async () => {
        throw new Error('teardown failed')
      },
    }))

    await expect(releaseProcessCore()).resolves.toBeUndefined()
    const next = await acquireProcessCore(async () => ({
      pidFilePath: '/ledger/next',
      teardown: async () => {},
    }))
    expect(next.pidFilePath).toBe('/ledger/next')
  })
})
