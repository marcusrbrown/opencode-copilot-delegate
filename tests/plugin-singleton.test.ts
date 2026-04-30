import { beforeEach, describe, expect, it } from 'bun:test'
import {
  _resetPluginSingleton,
  plugInOnce,
} from '../src/runtime/plugin-singleton'

describe('plugInOnce', () => {
  beforeEach(() => {
    _resetPluginSingleton()
  })

  it('runs doInit once and returns its result on first invocation', async () => {
    let calls = 0
    const doInit = async () => {
      calls += 1
      return { tool: 'one' }
    }
    const result = await plugInOnce({ doInit, pid: 1 })
    expect(result).toEqual({ tool: 'one' })
    expect(calls).toBe(1)
  })

  it('returns the same hooks reference on subsequent calls in the same PID', async () => {
    let calls = 0
    const hooks = { tool: 'cached' }
    const doInit = async () => {
      calls += 1
      return hooks
    }
    const r1 = await plugInOnce({ doInit, pid: 1 })
    const r2 = await plugInOnce({ doInit, pid: 1 })
    const r3 = await plugInOnce({ doInit, pid: 1 })
    expect(r1).toBe(hooks)
    expect(r2).toBe(hooks)
    expect(r3).toBe(hooks)
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
    expect(r1.call).toBe(1)
    expect(r2.call).toBe(2)
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
    expect(r1.call).toBe(1)
    expect(r2.call).toBe(2)
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

  it('caches a rejected doInit promise on subsequent calls', async () => {
    // Documents the known limitation in the JSDoc as test-form: when
    // `doInit()` rejects, the rejected promise is cached and every
    // subsequent invocation in the same PID returns the same rejection
    // without retrying init. Recovery requires a process restart.
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

  it('converges concurrent invocations on the same hooks promise', async () => {
    let started = 0
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
      return { tool: 'concurrent' }
    }
    const [r1, r2, r3] = await Promise.all([
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
      plugInOnce({ doInit, pid: 1 }),
    ])
    expect(r1).toBe(r2)
    expect(r2).toBe(r3)
    expect(started).toBe(1)
  })

  it('swallows onDuplicate exceptions', async () => {
    let initCalls = 0
    let duplicateCalls = 0
    const doInit = async () => {
      initCalls += 1
      return { ok: true }
    }
    const onDuplicate = () => {
      duplicateCalls += 1
      throw new Error('boom')
    }
    await plugInOnce({ doInit, onDuplicate, pid: 1 })
    // The throwing onDuplicate must not propagate to plugin init.
    const result = await plugInOnce({ doInit, onDuplicate, pid: 1 })
    expect(result).toEqual({ ok: true })
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
