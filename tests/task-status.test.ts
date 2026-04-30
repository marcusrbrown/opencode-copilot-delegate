import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { TaskStatus } from '../src/runtime/envelope'
import { appendPidEntry } from '../src/runtime/pid-file'
import { setStatus } from '../src/runtime/task-status'

const tempPaths: string[] = []

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    rmSync(p, { force: true, recursive: true })
  }
})

function makeTask(status: TaskStatus, pid: number) {
  return { status, pid }
}

describe('setStatus', () => {
  it('sets complete and removes PID file entry from running state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const task = makeTask('running', 12345)
    await appendPidEntry(
      pidFilePath,
      task.pid,
      'bash',
      'Mon Apr 27 10:00:00 2026',
    )

    setStatus(task, 'complete', { pidFilePath })
    expect(task.status).toBe('complete')

    await delay(100)
    expect(() => readFileSync(pidFilePath, 'utf-8')).toThrow()
  })

  it('preserves cancelled when setStatus is called with complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const task = makeTask('cancelled', 12345)
    await appendPidEntry(
      pidFilePath,
      task.pid,
      'bash',
      'Mon Apr 27 10:00:00 2026',
    )

    setStatus(task, 'complete', { pidFilePath })
    expect(task.status).toBe('cancelled')

    await delay(100)
    const content = readFileSync(pidFilePath, 'utf-8')
    expect(content).toContain('12345')
  })

  it('preserves failed when setStatus is called with cancelled', () => {
    const task = makeTask('failed', 12345)

    setStatus(task, 'cancelled')
    expect(task.status).toBe('failed')
  })

  it('preserves complete when setStatus is called with running', () => {
    const task = makeTask('complete', 12345)
    setStatus(task, 'running')
    expect(task.status).toBe('complete')
  })

  it('preserves failed when setStatus is called with running', () => {
    const task = makeTask('failed', 12345)
    setStatus(task, 'running')
    expect(task.status).toBe('failed')
  })

  it('preserves cancelled when setStatus is called with running and options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const task = makeTask('cancelled', 12345)
    await appendPidEntry(
      pidFilePath,
      task.pid,
      'bash',
      'Mon Apr 27 10:00:00 2026',
    )

    setStatus(task, 'running', { pidFilePath })
    expect(task.status).toBe('cancelled')

    // PID file entry must remain — no removePidEntry should have fired.
    await delay(100)
    const content = readFileSync(pidFilePath, 'utf-8')
    expect(content).toContain('12345')
  })

  it('allows non-terminal transitions without removing PID entry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const task = makeTask('running', 12345)
    await appendPidEntry(
      pidFilePath,
      task.pid,
      'bash',
      'Mon Apr 27 10:00:00 2026',
    )

    setStatus(task, 'running', { pidFilePath })
    expect(task.status).toBe('running')

    await delay(100)
    const content = readFileSync(pidFilePath, 'utf-8')
    expect(content).toContain('12345')
  })

  it('sets failed without options and does not throw', () => {
    const task = makeTask('running', 12345)

    setStatus(task, 'failed')
    expect(task.status).toBe('failed')
  })

  it('swallows removePidEntry rejection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)

    const task = makeTask('running', 12345)

    expect(() => {
      setStatus(task, 'complete', { pidFilePath: dir })
    }).not.toThrow()

    expect(task.status).toBe('complete')
  })

  it('is idempotent when task is already terminal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'task-status-'))
    tempPaths.push(dir)
    const pidFilePath = join(dir, 'orphans.pids')

    const task = makeTask('cancelled', 12345)
    await appendPidEntry(
      pidFilePath,
      task.pid,
      'bash',
      'Mon Apr 27 10:00:00 2026',
    )

    setStatus(task, 'cancelled', { pidFilePath })
    expect(task.status).toBe('cancelled')

    await delay(100)
    const content = readFileSync(pidFilePath, 'utf-8')
    expect(content).toContain('12345')
  })
})
