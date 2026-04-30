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

  it('converges concurrent invocations on the same hooks promise', async () => {
    let started = 0
    const doInit = async () => {
      started += 1
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
