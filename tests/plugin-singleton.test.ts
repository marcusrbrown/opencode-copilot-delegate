import { beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetPluginSingleton,
  plugInOnce,
} from '../src/runtime/plugin-singleton'

describe('plugInOnce', () => {
  beforeEach(() => {
    _resetPluginSingleton()
  })

  it('returns isFirst:true with real hooks on first invocation', async () => {
    let calls = 0
    const realHooks = { tool: { example: 'tool' } }
    const doInit = async () => {
      calls += 1
      return realHooks
    }
    const result = await plugInOnce({ doInit, pid: 1 })
    expect(result.isFirst).toBe(true)
    expect(result.hooks).toBe(realHooks)
    expect(calls).toBe(1)
  })

  it('returns isFirst:false with empty hooks on duplicate invocations in the same PID', async () => {
    // The empty-hooks contract is the entire point of Option-2: the OpenCode
    // host iterates each plugin source's returned hook surface and registers
    // every tool entry it finds, even when two sources return the same JS
    // reference. Returning the cached real hooks from the duplicate path
    // would cause the host to register tools twice. Returning {} is the only
    // shape that prevents host-side double registration.
    let calls = 0
    const realHooks = { tool: { example: 'tool' } }
    const doInit = async () => {
      calls += 1
      return realHooks
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    const r2 = await plugInOnce({ doInit, pid: 1 })
    const r3 = await plugInOnce({ doInit, pid: 1 })

    expect(r1.isFirst).toBe(true)
    expect(r1.hooks).toBe(realHooks)

    expect(r2.isFirst).toBe(false)
    expect(r2.hooks).not.toBe(realHooks)
    expect(Object.keys(r2.hooks)).toEqual([])

    expect(r3.isFirst).toBe(false)
    expect(r3.hooks).not.toBe(realHooks)
    expect(Object.keys(r3.hooks)).toEqual([])

    expect(calls).toBe(1)
  })

  it('runs init again when pid changes (different process)', async () => {
    let calls = 0
    const doInit = async () => {
      calls += 1
      return { call: calls }
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    _resetPluginSingleton() // simulate "new process" globalThis fresh
    const r2 = await plugInOnce({ doInit, pid: 2 })
    expect(r1.isFirst).toBe(true)
    expect(r1.hooks.call).toBe(1)
    expect(r2.isFirst).toBe(true)
    expect(r2.hooks.call).toBe(2)
    expect(calls).toBe(2)
  })

  it('reruns init on a different pid without manual reset', async () => {
    // Exercises the singleton's PID-mismatch branch directly: populate
    // state with pid=1, then call again with pid=2 WITHOUT calling
    // `_resetPluginSingleton()`. Init must run fresh because the cached
    // pid does not match. This is the production code path for any
    // (extremely unlikely) cross-process state leak — the test confirms
    // the guard fires without test-only plumbing.
    let calls = 0
    const doInit = async () => {
      calls += 1
      return { call: calls }
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    const r2 = await plugInOnce({ doInit, pid: 2 })
    expect(r1.isFirst).toBe(true)
    expect(r1.hooks.call).toBe(1)
    expect(r2.isFirst).toBe(true)
    expect(r2.hooks.call).toBe(2)
    expect(calls).toBe(2)
  })

  it('fires onDuplicate exactly once on first duplicate invocation', async () => {
    let duplicateCalls = 0
    const doInit = async () => ({})
    const onDuplicate = () => {
      duplicateCalls += 1
    }
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    expect(duplicateCalls).toBe(1)
  })

  it('does not fire onDuplicate on the first invocation', async () => {
    let duplicateCalls = 0
    await plugInOnce({
      doInit: async () => ({}),
      onDuplicate: () => {
        duplicateCalls += 1
      },
      pid: 1,
    })
    expect(duplicateCalls).toBe(0)
  })

  it('passes the resolved pid to onDuplicate (test override flows through)', async () => {
    // The `pid` parameter is meant to make the singleton testable in a
    // single-process Bun run by simulating different OS PIDs. The duplicate
    // warning emitted by callers includes the PID for diagnostics, so the
    // value passed to `onDuplicate` must match the one the guard used —
    // not the live `process.pid` — so test overrides surface faithfully.
    let receivedPid: number | undefined
    const onDuplicate = (pid: number) => {
      receivedPid = pid
    }
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 9001 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 9001 })
    expect(receivedPid).toBe(9001)
  })

  it('propagates a rejected doInit to first and duplicate callers', async () => {
    // Documents the known limitation in the JSDoc as test-form: when
    // `doInit()` rejects, the rejected promise is cached and every
    // subsequent invocation in the same PID surfaces the same rejection
    // without retrying init. Recovery requires a process restart. The
    // duplicate path awaits the cached promise so sticky rejections
    // propagate to all callers, not just the first.
    const error = new Error('init failed')
    let calls = 0
    const doInit = async () => {
      calls += 1
      throw error
    }
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    await expect(plugInOnce({ doInit, pid: 1 })).rejects.toBe(error)
    expect(calls).toBe(1)
  })

  it('runs doInit exactly once across concurrent invocations', async () => {
    let started = 0
    const realHooks = { tool: 'concurrent' }
    const doInit = async () => {
      started += 1
      // The 20ms delay is intentionally larger than the time it takes for
      // `Promise.all([...])` to issue all three `plugInOnce` calls. The
      // second and third calls observe the in-flight promise already
      // cached on `globalThis` and skip running `doInit`. Bun's microtask
      // scheduler resolves the synchronous portion of all three calls
      // before the 20ms timer fires; if a future Bun release introduces
      // microtask preemption between awaits, this test would need to
      // pivot to an explicit deferred-resolve fixture.
      await new Promise((r) => setTimeout(r, 20))
      return realHooks
    }
    const [r1, r2, r3] = await Promise.all([
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
    ])
    // Only one call ran init.
    expect(started).toBe(1)

    // The first call to claim the singleton slot resolves with isFirst:true
    // and the real hooks. Promise.all preserves array order matching the
    // input array, so r1 is the call that arrived first.
    expect(r1.isFirst).toBe(true)
    expect(r1.hooks).toBe(realHooks)

    // Subsequent concurrent callers resolve with isFirst:false and {} so
    // the host does not double-register tools.
    expect(r2.isFirst).toBe(false)
    expect(Object.keys(r2.hooks)).toEqual([])
    expect(r3.isFirst).toBe(false)
    expect(Object.keys(r3.hooks)).toEqual([])
  })

  it('swallows onDuplicate exceptions without affecting init result', async () => {
    let initCalls = 0
    let duplicateCalls = 0
    const realHooks = { ok: true }
    const doInit = async () => {
      initCalls += 1
      return realHooks
    }
    const onDuplicate = () => {
      duplicateCalls += 1
      throw new Error('boom')
    }
    const r1 = await plugInOnce({ doInit, onDuplicate, pid: 1 })
    // The throwing onDuplicate must not propagate into the duplicate
    // result; the duplicate call still resolves with empty hooks.
    const r2 = await plugInOnce({ doInit, onDuplicate, pid: 1 })

    expect(r1.isFirst).toBe(true)
    expect(r1.hooks).toBe(realHooks)

    expect(r2.isFirst).toBe(false)
    expect(Object.keys(r2.hooks)).toEqual([])

    expect(duplicateCalls).toBe(1)
    expect(initCalls).toBe(1)
  })

  it('does not fire onDuplicate again after the first time, even if onDuplicate threw', async () => {
    let duplicateCalls = 0
    const onDuplicate = () => {
      duplicateCalls += 1
      throw new Error('boom')
    }
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    await plugInOnce({ doInit: async () => ({}), onDuplicate, pid: 1 })
    expect(duplicateCalls).toBe(1)
  })
})
