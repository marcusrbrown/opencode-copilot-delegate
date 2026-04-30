import { describe, expect, it } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isErrnoException } from '../src/lib/errno'
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
    timedOut: false,
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

    it('reports timedOut with zero counts even after partial progress', async () => {
      // Locks the contract: when the overall timeout wins, in-flight
      // workers may have already invoked side effects (killProcessTree,
      // counter increments) before the abort signal landed, but those
      // are NOT reflected in the returned counts. Counts are placeholders.
      //
      // Uses process.pid and process.ppid for entry pids because
      // processEntry probes `process.kill(entry.pid, 0)` before calling
      // getPidIdentity; synthetic ghost pids would short-circuit as
      // skipped and never exercise the slow probe path.
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)
      const foreignDeadPath = join(dir, '9999.pids')
      writePidFile(currentPath, [])
      writePidFile(foreignDeadPath, [
        { pid: process.pid, comm: 'sleep', lstart: 't1' },
        { pid: process.ppid, comm: 'sleep', lstart: 't2' },
      ])

      let killCount = 0
      const res = await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {
          killCount++
        },
        getPidIdentity: (pid) => {
          // First entry: returns matching identity immediately and is reaped.
          if (pid === process.pid)
            return Promise.resolve({ comm: 'sleep', lstart: 't1' })
          // Second entry: hangs past reapTimeoutMs so timeout wins the race.
          return new Promise((resolve) => setTimeout(() => resolve(null), 200))
        },
        isPluginAlive: (pid) => pid !== 9999,
        reapTimeoutMs: 50,
      })

      expect(res.timedOut).toBe(true)
      expect(res.reaped).toBe(0)
      expect(res.scannedFiles).toBe(0)
      expect(res.deletedFiles).toBe(0)
      // Side effect observable: entry for process.pid was killed before the
      // timeout, but the count fields don't reflect it.
      expect(killCount).toBe(1)
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
        expect(warnings.some((w) => w.startsWith('[copilot-delegate]'))).toBe(
          true,
        )
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

    it('forwards psTimeoutMs through the worker pool to injected getPidIdentity', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      // Two distinct entries so we observe forwarding across multiple
      // worker invocations, not just the first call.
      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
        { pid: process.ppid, comm: 'copilot', lstart: 't2' },
      ])

      const recordedTimeouts: (number | undefined)[] = []

      await reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidIdentity: async (_pid, timeoutMs) => {
          recordedTimeouts.push(timeoutMs)
          // Returning null skips the kill path; we only care about
          // verifying that the forwarded timeoutMs reaches each worker.
          return null
        },
        psTimeoutMs: 2500,
      })

      expect(recordedTimeouts).toHaveLength(2)
      expect(recordedTimeouts.every((t) => t === 2500)).toBe(true)
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

    it('does not truncate current-instance file when timeout fires mid-reap', async () => {
      // Regression test for the race where lingering reap workers complete
      // after the overall timeout, then truncate the current-instance file
      // — wiping any entries that new tasks have appended in the meantime.
      // The fix is cooperative cancellation: when the overall timeout fires,
      // reapOneFile must skip cleanupAfterReap.
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      // Pre-populate with a stale entry so reapOneFile descends into
      // processEntries and triggers the slow getPidIdentity below.
      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 'stale' },
      ])

      // Start the reap. getPidIdentity hangs for 200ms; reapTimeoutMs is 50ms,
      // so the timeout fires while workers are still in processEntries.
      const reapPromise = reapOrphans({
        pidFileDir: dir,
        currentInstancePath: currentPath,
        killProcessTree: async () => {},
        getPidIdentity: () =>
          new Promise((resolve) => setTimeout(() => resolve(null), 200)),
        reapTimeoutMs: 50,
      })

      const res = await reapPromise
      expect(res).toEqual(result({ timedOut: true }))

      // Simulate a new task being spawned right after init returns: append
      // a fresh entry to the current-instance file.
      appendFileSync(currentPath, `${process.pid}\tcopilot\tfresh\n`)

      // Wait long enough for any lingering workers (the 200ms slow probe)
      // to complete their final continuation through cleanupAfterReap.
      await new Promise((resolve) => setTimeout(resolve, 300))

      // The fresh entry must still be in the file. Without cooperative
      // cancellation, cleanupAfterReap's writeFile('', ...) truncates the
      // file at ~200ms and wipes the fresh entry, leaving permanent orphans.
      const content = readFileSync(currentPath, 'utf-8')
      expect(content).toContain('fresh')
    })

    it('honors reapTimeoutMs and returns empty result with warn on timeout', async () => {
      const dir = makeTempDir()
      const currentPath = join(dir, `${process.pid}.pids`)

      writePidFile(currentPath, [
        { pid: process.pid, comm: 'copilot', lstart: 't1' },
      ])

      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(' '))
      }

      try {
        // getPidIdentity takes 200ms; reapTimeoutMs=50 fires first.
        // The reap returns the zero result, and the slow probe completes
        // silently in the background.
        const res = await reapOrphans({
          pidFileDir: dir,
          currentInstancePath: currentPath,
          killProcessTree: async () => {},
          getPidIdentity: () =>
            new Promise((resolve) => setTimeout(() => resolve(null), 200)),
          reapTimeoutMs: 50,
        })

        expect(res).toEqual(result({ timedOut: true }))
        const matched = warnings.find(
          (w) =>
            w.includes('copilot-delegate') &&
            w.includes('reapOrphans') &&
            w.includes('50'),
        )
        expect(matched).toBeTruthy()
      } finally {
        console.warn = origWarn
      }
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

    it('should return true for a system PID owned by another user (EPERM-as-alive)', () => {
      // PID 1 (init/launchd) is owned by root. Calling process.kill(1, 0)
      // from a non-root user throws EPERM, which defaultIsPluginAlive
      // interprets as "alive but unsignaled" and returns true. This
      // exercises the EPERM branch directly without injected mocks.
      //
      // Skip when this environment does not surface EPERM for PID 1 (root,
      // Windows, or any platform where the probe behaves differently).
      let preflightThrewEperm = false
      try {
        process.kill(1, 0)
      } catch (e) {
        preflightThrewEperm = isErrnoException(e) && e.code === 'EPERM'
      }
      if (!preflightThrewEperm) return

      expect(defaultIsPluginAlive(1)).toBe(true)
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

    it('honors a configurable timeout for the ps probe', async () => {
      // 1ms is reliably shorter than spawn+exec+IO of any real ps, so the
      // timeout fires first and the function returns null. This proves the
      // timeoutMs parameter is wired through to runPs.
      const identity = await getPidIdentity(process.pid, 1)
      expect(identity).toBeNull()
    })

    it('emits a degradation warning when the ps timeout fires', async () => {
      const warnings: string[] = []
      const origWarn = console.warn
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(' '))
      }
      try {
        await getPidIdentity(process.pid, 1)
        const matched = warnings.find(
          (w) => w.includes('copilot-delegate') && w.includes('timeout'),
        )
        expect(matched).toBeTruthy()
      } finally {
        console.warn = origWarn
      }
    })

    it('returns null when ps binary cannot be spawned', async () => {
      // Set PATH to an empty directory so spawn('ps', ...) inside runPs
      // fails with ENOENT. The 'error' event handler in runPs swallows
      // the failure and resolves null; getPidIdentity propagates that as
      // null without throwing. This exercises the spawn-error fallback
      // path that no other test reaches.
      let emptyDir: string | undefined
      let originalPath: string | undefined
      try {
        emptyDir = mkdtempSync(join(tmpdir(), 'empty-path-'))
        originalPath = process.env.PATH
        process.env.PATH = emptyDir

        const identity = await getPidIdentity(process.pid)
        expect(identity).toBeNull()
      } finally {
        process.env.PATH = originalPath
        // Best-effort cleanup of the temp PATH dir.
        try {
          if (emptyDir) {
            rmSync(emptyDir, { recursive: true })
          }
        } catch {
          // ignore
        }
      }
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
