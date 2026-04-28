import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendPidEntry,
  removePidEntry,
  resolveInstancePidFilePath,
} from '../src/runtime/pid-file'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pid-file-test-'))
}

describe('pid-file', () => {
  describe('path resolution', () => {
    it('should resolve to <state-dir>/opencode-copilot-delegate/orphans/<process.pid>.pids', () => {
      const stateDir =
        process.env.XDG_STATE_HOME ?? join(tmpdir(), '.local', 'state')

      const result = resolveInstancePidFilePath()

      expect(result).toBe(
        join(
          stateDir,
          'opencode-copilot-delegate',
          'orphans',
          `${process.pid}.pids`,
        ),
      )
    })

    it('should use XDG_STATE_HOME when present', () => {
      const original = process.env.XDG_STATE_HOME
      process.env.XDG_STATE_HOME = '/custom/state'

      try {
        const result = resolveInstancePidFilePath()
        expect(result).toBe(
          join(
            '/custom/state',
            'opencode-copilot-delegate',
            'orphans',
            `${process.pid}.pids`,
          ),
        )
      } finally {
        if (original !== undefined) {
          process.env.XDG_STATE_HOME = original
        } else {
          delete process.env.XDG_STATE_HOME
        }
      }
    })
  })

  describe('appendPidEntry happy path', () => {
    it('should write a single tab-separated line to a fresh file', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')

      await appendPidEntry(
        filePath,
        12345,
        'copilot',
        'Mon Jan 1 00:00:00 2024',
      )

      const content = readFileSync(filePath, 'utf-8')
      expect(content).toBe('12345\tcopilot\tMon Jan 1 00:00:00 2024\n')

      const stats = statSync(filePath)
      expect(stats.mode & 0o777).toBe(0o600)
    })

    it('should create parent dir with 0o700 when missing', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'nested', 'deep', 'test.pids')

      await appendPidEntry(
        filePath,
        12345,
        'copilot',
        'Mon Jan 1 00:00:00 2024',
      )

      const content = readFileSync(filePath, 'utf-8')
      expect(content).toBe('12345\tcopilot\tMon Jan 1 00:00:00 2024\n')

      const dirStats = statSync(join(dir, 'nested', 'deep'))
      expect(dirStats.mode & 0o777).toBe(0o700)
    })

    it('should preserve three sequential appends in spawn order', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')

      await appendPidEntry(filePath, 1, 'a', 't1')
      await appendPidEntry(filePath, 2, 'b', 't2')
      await appendPidEntry(filePath, 3, 'c', 't3')

      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(3)
      expect(lines[0]).toBe('1\ta\tt1')
      expect(lines[1]).toBe('2\tb\tt2')
      expect(lines[2]).toBe('3\tc\tt3')
    })
  })

  describe('removePidEntry happy path', () => {
    it('should remove the matching entry and preserve order', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')

      await appendPidEntry(filePath, 1, 'a', 't1')
      await appendPidEntry(filePath, 2, 'b', 't2')
      await appendPidEntry(filePath, 3, 'c', 't3')

      await removePidEntry(filePath, 2)

      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('1\ta\tt1')
      expect(lines[1]).toBe('3\tc\tt3')
    })

    it('should no-op when PID is not in file', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')

      await appendPidEntry(filePath, 1, 'a', 't1')
      await appendPidEntry(filePath, 2, 'b', 't2')

      await removePidEntry(filePath, 999)

      const content = readFileSync(filePath, 'utf-8')
      const lines = content.trim().split('\n')
      expect(lines).toHaveLength(2)
    })

    it('should no-op when file is missing', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'missing.pids')

      await removePidEntry(filePath, 123)

      expect(() => statSync(filePath)).toThrow()
    })
  })

  describe('mode preservation', () => {
    it('should keep file mode at 0o600 after append and remove', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')

      await appendPidEntry(filePath, 1, 'a', 't1')
      let stats = statSync(filePath)
      expect(stats.mode & 0o777).toBe(0o600)

      await appendPidEntry(filePath, 2, 'b', 't2')
      stats = statSync(filePath)
      expect(stats.mode & 0o777).toBe(0o600)

      await removePidEntry(filePath, 1)
      stats = statSync(filePath)
      expect(stats.mode & 0o777).toBe(0o600)
    })
  })

  describe('concurrency', () => {
    it('should serialize 10 concurrent appends into exactly 10 entries', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'concurrent.pids')

      const triples = Array.from({ length: 10 }, (_, i) => ({
        pid: 1000 + i,
        comm: `proc-${i}`,
        lstart: `time-${i}`,
      }))

      await Promise.all(
        triples.map((t) => appendPidEntry(filePath, t.pid, t.comm, t.lstart)),
      )

      const content = readFileSync(filePath, 'utf-8')
      const lines = content
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
      expect(lines).toHaveLength(10)

      const pids = new Set<number>()
      for (const line of lines) {
        const parts = line.split('\t')
        expect(parts).toHaveLength(3)
        expect(parts[0]).toMatch(/^\d+$/)
        expect(parts[1]).toMatch(/^proc-\d+$/)
        expect(parts[2]).toMatch(/^time-\d+$/)
        pids.add(Number(parts[0]))
      }
      expect(pids.size).toBe(10)
    })
  })
})
