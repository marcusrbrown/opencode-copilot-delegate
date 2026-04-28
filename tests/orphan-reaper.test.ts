import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultIsPluginAlive,
  reapOrphans,
  type ReapResult,
} from '../src/runtime/orphan-reaper'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orphan-reaper-test-'))
}

function writePidFile(
  filePath: string,
  entries: Array<{ pid: number; comm: string; lstart: string }>,
): void {
  const lines = entries
    .map((e) => `${e.pid}\t${e.comm}\t${e.lstart}`)
    .join('\n')
  writeFileSync(filePath, lines ? lines + '\n' : '')
}

function result(overrides: Partial<ReapResult> = {}): ReapResult {
  return {
    reaped: 0,
    skipped: 0,
    scannedFiles: 0,
    deletedFiles: 0,
    ...overrides,
  }
}

describe('orphan-reaper', () => {
  describe('happy path', () => {
    it('should return zeros for empty pidFileDir', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => null,
        getPidStartTime: async () => null,
      })

      expect(res).toEqual(result())
    })

    it('should reap alive-matching entry from current file and truncate', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const killedPids: number[] = []

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async (pid) => {
          killedPids.push(pid)
        },
        getPidComm: async () => 'copilot',
        getPidStartTime: async () => 't1',
      })

      expect(res).toEqual(
        result({ reaped: 1, skipped: 0, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(killedPids).toEqual([process.pid])
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
    })

    it('should handle multi-file mixed-instance scenario', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const foreignDeadPath = join(dir, '9999.pids')
      const foreignAlivePath = join(dir, '8888.pids')
      const killedPids: number[] = []

      // Current file: 1 alive-match, 1 dead
      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
        { pid: 99999, comm: 'copilot', lstart: 't2' },
      ])

      // Foreign dead spawner: 1 alive-match
      writePidFile(foreignDeadPath, [
        { pid: process.ppid, comm: 'copilot', lstart: 't3' },
      ])

      // Foreign alive spawner: 2 entries (skipped entirely at spawner gate)
      writePidFile(foreignAlivePath, [
        { pid: process.pid, comm: 'copilot', lstart: 't4' },
        { pid: process.pid, comm: 'copilot', lstart: 't5' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async (pid) => {
          killedPids.push(pid)
        },
        getPidComm: async (pid) => {
          if (pid === process.pid || pid === process.ppid) return 'copilot'
          return null
        },
        getPidStartTime: async (pid) => {
          if (pid === process.pid) return 't1'
          if (pid === process.ppid) return 't3'
          return null
        },
        isPluginAlive: (pid) => {
          if (pid === 9999) return false
          if (pid === 8888) return true
          return defaultIsPluginAlive(pid)
        },
      })

      expect(res).toEqual(
        result({ reaped: 2, skipped: 1, scannedFiles: 2, deletedFiles: 1 }),
      )
      expect(killedPids.sort((a, b) => a - b)).toEqual(
        [process.pid, process.ppid].sort((a, b) => a - b),
      )
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
      expect(() => readFileSync(foreignDeadPath, 'utf-8')).toThrow()
      expect(readFileSync(foreignAlivePath, 'utf-8')).toBeDefined()
    })
  })

  describe('edge cases', () => {
    it('should skip foreign file when isPluginAlive returns true (EPERM)', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const foreignPath = join(dir, '7777.pids')
      const killedPids: number[] = []

      writePidFile(foreignPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async (pid) => {
          killedPids.push(pid)
        },
        getPidComm: async () => 'copilot',
        getPidStartTime: async () => 't1',
        isPluginAlive: () => true,
      })

      expect(res).toEqual(result())
      expect(killedPids).toHaveLength(0)
      expect(readFileSync(foreignPath, 'utf-8')).toBeDefined()
    })

    it('should warn and skip non-numeric foreign filename without deleting', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const garbagePath = join(dir, 'garbage.pids')

      writePidFile(garbagePath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(' '))
      }

      try {
        const res = await reapOrphans({
          pidFileDir: dir,
          currentInstancePath: currentPath,
          killProcessTree: async () => {},
          getPidComm: async () => null,
          getPidStartTime: async () => null,
        })

        expect(res).toEqual(result())
        expect(warnings.some((w) => w.includes('garbage'))).toBe(true)
        expect(readFileSync(garbagePath, 'utf-8')).toBeDefined()
      } finally {
        console.warn = origWarn
      }
    })

    it('should delete foreign dead-spawner file when all entries are dead', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const foreignPath = join(dir, '9999.pids')

      writePidFile(foreignPath, [
        { pid: 99991, comm: 'copilot', lstart: 't1' },
        { pid: 99992, comm: 'copilot', lstart: 't2' },
        { pid: 99993, comm: 'copilot', lstart: 't3' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => null,
        getPidStartTime: async () => null,
        isPluginAlive: (pid) => pid !== 9999,
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 3, scannedFiles: 1, deletedFiles: 1 }),
      )
      expect(() => readFileSync(foreignPath, 'utf-8')).toThrow()
    })

    it('should skip mismatched identity in foreign dead file and still delete', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const foreignPath = join(dir, '9999.pids')

      writePidFile(foreignPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => 'not-copilot',
        getPidStartTime: async () => 't1',
        isPluginAlive: (pid) => pid !== 9999,
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 1 }),
      )
      expect(() => readFileSync(foreignPath, 'utf-8')).toThrow()
    })

    it('should skip comm mismatch on current file and truncate', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => 'not-copilot',
        getPidStartTime: async () => 't1',
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
    })

    it('should skip lstart mismatch on current file and truncate', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => 'copilot',
        getPidStartTime: async () => 'different-time',
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
    })

    it('should count dead PID as skipped and truncate current file', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [{ pid: 99999, comm: 'copilot', lstart: 't1' }])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => null,
        getPidStartTime: async () => null,
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
    })
  })

  describe('concurrency', () => {
    it('should cap concurrent getPidComm invocations at 5 for 10 entries', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      let maxConcurrent = 0
      let currentConcurrent = 0

      const entries = Array.from({ length: 10 }, () => ({
        pid: process.pid,
        comm: 'copilot',
        lstart: 't0',
      }))
      writePidFile(currentPath, entries)

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
          await new Promise((r) => setTimeout(r, 30))
          currentConcurrent--
          return 'copilot'
        },
        getPidStartTime: async () => {
          await new Promise((r) => setTimeout(r, 30))
          return 't0'
        },
      })

      expect(res.reaped).toBe(10)
      expect(maxConcurrent).toBeLessThanOrEqual(5)
    })
  })

  describe('error paths', () => {
    it('should silently skip malformed lines', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writeFileSync(
        currentPath,
        'this-is-not-valid\n' +
          `${process.pid}\tcopilot\tt1\n` +
          '\n' +
          'also-bad\n',
      )

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => 'copilot',
        getPidStartTime: async () => 't1',
      })

      expect(res).toEqual(
        result({ reaped: 1, skipped: 0, scannedFiles: 1, deletedFiles: 0 }),
      )
    })

    it('should catch killProcessTree throw, count skipped, and continue', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const killedPids: number[] = []

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
        { pid: process.ppid, comm: 'copilot', lstart: 't2' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async (pid) => {
          if (pid === process.pid) throw new Error('kill failed')
          killedPids.push(pid)
        },
        getPidComm: async (pid) => {
          if (pid === process.pid || pid === process.ppid) return 'copilot'
          return null
        },
        getPidStartTime: async (pid) => {
          if (pid === process.pid) return 't1'
          if (pid === process.ppid) return 't2'
          return null
        },
      })

      expect(res).toEqual(
        result({ reaped: 1, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(killedPids).toEqual([process.ppid])
    })

    it('should skip when getPidStartTime returns null for alive PID', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidComm: async () => 'copilot',
        getPidStartTime: async () => null,
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
    })

    it('should return zeros when fs.readdir throws (missing dir)', async () => {
      const res = await reapOrphans({
        pidFileDir: '/nonexistent/dir/for/sure',
        currentInstancePath: '/nonexistent/dir/for/sure/test.pids',
        killProcessTree: async () => {},
        getPidComm: async () => null,
        getPidStartTime: async () => null,
      })

      expect(res).toEqual(result())
    })
  })

  describe('defaultIsPluginAlive', () => {
    it('should return true for current process', () => {
      expect(defaultIsPluginAlive(process.pid)).toBe(true)
    })

    it('should return false for non-existent PID', () => {
      expect(defaultIsPluginAlive(99999)).toBe(false)
    })
  })
})
