import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultIsPluginAlive,
  getPidIdentity,
  parsePsIdentity,
  type ReapResult,
  reapOrphans,
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
  writeFileSync(filePath, lines ? `${lines}\n` : '')
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
        getPidIdentity: async () => null,
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
        getPidIdentity: async () => ({ comm: 'copilot', lstart: 't1' }),
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
        getPidIdentity: async (pid) => {
          if (pid === process.pid) return { comm: 'copilot', lstart: 't1' }
          if (pid === process.ppid) return { comm: 'copilot', lstart: 't3' }
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
        getPidIdentity: async () => ({ comm: 'copilot', lstart: 't1' }),
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
          getPidIdentity: async () => null,
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
        getPidIdentity: async () => null,
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
        getPidIdentity: async () => ({ comm: 'not-copilot', lstart: 't1' }),
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
        getPidIdentity: async () => ({ comm: 'not-copilot', lstart: 't1' }),
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
        getPidIdentity: async () => ({
          comm: 'copilot',
          lstart: 'different-time',
        }),
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
        getPidIdentity: async () => null,
      })

      expect(res).toEqual(
        result({ reaped: 0, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(readFileSync(currentPath, 'utf-8')).toBe('')
    })
  })

  describe('concurrency', () => {
    it('should not block subsequent entries on a single slow probe (streaming worker pool)', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      let callCount = 0
      let slowFinished = false
      let finishedBeforeSlow = 0

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
        getPidIdentity: async () => {
          callCount++
          const isSlow = callCount === 1
          const delay = isSlow ? 200 : 10
          await new Promise((r) => setTimeout(r, delay))
          if (isSlow) {
            slowFinished = true
          } else if (!slowFinished) {
            finishedBeforeSlow++
          }
          return { comm: 'copilot', lstart: 't0' }
        },
      })

      expect(res.reaped).toBe(10)
      // With a streaming worker pool: the slow probe occupies worker 0 for
      // 200ms; workers 1–4 each handle ~2-3 of the remaining 9 fast probes
      // (10ms each) and finish well before t=200ms. All 9 fast probes complete
      // before the slow one, hence the >= 9 lower bound.
      //
      // With chunked-of-5: the first chunk of 5 (1 slow + 4 fast) waits for
      // the slow probe at t=200ms; the next chunk of 5 fast probes only starts
      // at t=200ms and all finish AFTER the slow one, yielding exactly 4.
      expect(finishedBeforeSlow).toBeGreaterThanOrEqual(9)
    })

    it('should cap concurrent getPidIdentity invocations at 5 for 10 entries', async () => {
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
        getPidIdentity: async () => {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
          await new Promise((r) => setTimeout(r, 30))
          currentConcurrent--
          return { comm: 'copilot', lstart: 't0' }
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
        getPidIdentity: async () => ({ comm: 'copilot', lstart: 't1' }),
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
        getPidIdentity: async (pid) => {
          if (pid === process.pid) return { comm: 'copilot', lstart: 't1' }
          if (pid === process.ppid) return { comm: 'copilot', lstart: 't2' }
          return null
        },
      })

      expect(res).toEqual(
        result({ reaped: 1, skipped: 1, scannedFiles: 1, deletedFiles: 0 }),
      )
      expect(killedPids).toEqual([process.ppid])
    })

    it('should skip when getPidIdentity returns null for alive PID', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidIdentity: async () => null,
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
        getPidIdentity: async () => null,
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

  describe('getPidIdentity', () => {
    it('should return both comm and lstart for the current process from a single ps call', async () => {
      const identity = await getPidIdentity(process.pid)
      expect(identity).not.toBeNull()
      expect(typeof identity?.comm).toBe('string')
      expect(identity?.comm.length).toBeGreaterThan(0)
      expect(typeof identity?.lstart).toBe('string')
      expect(identity?.lstart.length).toBeGreaterThan(0)
    })

    it('should return null for a non-existent PID', async () => {
      // 4_194_305 is above pid_max on Linux/macOS, guaranteed not assigned.
      const identity = await getPidIdentity(4_194_305)
      expect(identity).toBeNull()
    })
  })

  describe('parsePsIdentity', () => {
    it('returns null for empty input', () => {
      expect(parsePsIdentity('')).toBeNull()
    })

    it('returns null for a single token with no lstart', () => {
      expect(parsePsIdentity('copilot')).toBeNull()
    })

    it('returns null for input with only whitespace', () => {
      expect(parsePsIdentity('   ')).toBeNull()
    })

    it('returns null for leading-whitespace input (trim is the caller responsibility)', () => {
      // runPs trims its output before calling the parser. If a caller forgets
      // to trim, the parser fails safe by emitting null rather than producing
      // a comm with an empty string.
      expect(parsePsIdentity(' copilot Tue Apr 28 23:45:30 2026')).toBeNull()
    })

    it('parses standard ps -o comm=,lstart= output', () => {
      expect(parsePsIdentity('copilot Tue Apr 28 23:45:30 2026')).toEqual({
        comm: 'copilot',
        lstart: 'Tue Apr 28 23:45:30 2026',
      })
    })

    it('handles a 15-char comm boundary (Linux kernel cap)', () => {
      // Linux truncates `comm` at 15 chars. A maximum-length value should
      // still parse cleanly.
      const comm = 'a'.repeat(15)
      expect(parsePsIdentity(`${comm} Tue Apr 28 23:45:30 2026`)).toEqual({
        comm,
        lstart: 'Tue Apr 28 23:45:30 2026',
      })
    })

    it('handles a 16-char comm boundary (macOS kernel cap)', () => {
      // macOS truncates `comm` at 16 chars.
      const comm = 'b'.repeat(16)
      expect(parsePsIdentity(`${comm} Tue Apr 28 23:45:30 2026`)).toEqual({
        comm,
        lstart: 'Tue Apr 28 23:45:30 2026',
      })
    })

    it('collapses multi-whitespace separator into the lstart trim', () => {
      // If ps emits column padding that survives runPs.trim(), the parser
      // still recovers a correct lstart by trimming after the slice.
      expect(parsePsIdentity('copilot   Tue Apr 28 23:45:30 2026')).toEqual({
        comm: 'copilot',
        lstart: 'Tue Apr 28 23:45:30 2026',
      })
    })
  })
})
