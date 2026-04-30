import { describe, expect, it } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendPidEntry,
  removePidEntry,
  resolveInstancePidFilePath,
  truncatePidFile,
  unlinkPidFile,
} from '../src/runtime/pid-file'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pid-file-test-'))
}

describe('pid-file', () => {
  describe('path resolution', () => {
    it('should resolve to <state-dir>/opencode-copilot-delegate/orphans/<process.pid>.pids', () => {
      const original = process.env.XDG_STATE_HOME
      delete process.env.XDG_STATE_HOME

      try {
        const stateDir = join(homedir(), '.local', 'state')
        const result = resolveInstancePidFilePath()

        expect(result).toBe(
          join(
            stateDir,
            'opencode-copilot-delegate',
            'orphans',
            `${process.pid}.pids`,
          ),
        )
      } finally {
        if (original !== undefined) {
          process.env.XDG_STATE_HOME = original
        }
      }
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
        .filter((l: string) => l.length > 0)
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

  describe('truncatePidFile', () => {
    it('clears file content', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')
      await writeFile(filePath, '12345\tbash\tMon Apr 27 10:00:00 2026\n')

      await truncatePidFile(filePath)

      expect(readFileSync(filePath, 'utf-8')).toBe('')
    })

    it('swallows ENOENT silently', async () => {
      const dir = makeTempDir()
      // Parent dir does not exist -> writeFile rejects with ENOENT
      const filePath = join(dir, 'missing-subdir', 'missing.pids')

      await expect(truncatePidFile(filePath)).resolves.toBeUndefined()
      expect(existsSync(filePath)).toBe(false)
    })
  })

  describe('unlinkPidFile', () => {
    it('removes the file', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'test.pids')
      await writeFile(filePath, '12345\tbash\tMon Apr 27 10:00:00 2026\n')

      await unlinkPidFile(filePath)

      expect(existsSync(filePath)).toBe(false)
    })

    it('swallows ENOENT silently', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'missing.pids')

      await expect(unlinkPidFile(filePath)).resolves.toBeUndefined()
    })
  })

  describe('symlink hardening', () => {
    it('rejects a symlinked pid file in appendPidEntry', async () => {
      const dir = makeTempDir()
      const targetPath = join(dir, 'target.txt')
      const filePath = join(dir, 'test.pids')

      writeFileSync(targetPath, 'secret\n')
      symlinkSync(targetPath, filePath)

      await expect(
        appendPidEntry(filePath, 12345, 'copilot', 'Mon Jan 1 00:00:00 2024'),
      ).rejects.toThrow()

      expect(lstatSync(filePath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf-8')).toBe('secret\n')
    })

    it('rejects a symlinked parent directory in appendPidEntry', async () => {
      const dir = makeTempDir()
      const realDir = join(dir, 'real-orphans')
      const linkedDir = join(dir, 'linked-orphans')
      const filePath = join(linkedDir, 'test.pids')

      mkdirSync(realDir, { mode: 0o700 })
      symlinkSync(realDir, linkedDir)

      await expect(
        appendPidEntry(filePath, 12345, 'copilot', 'Mon Jan 1 00:00:00 2024'),
      ).rejects.toThrow(/refusing symlink path/)

      expect(lstatSync(linkedDir).isSymbolicLink()).toBe(true)
      expect(existsSync(join(realDir, 'test.pids'))).toBe(false)
    })

    it('rejects a symlinked pid file in removePidEntry', async () => {
      const dir = makeTempDir()
      const targetPath = join(dir, 'target.txt')
      const filePath = join(dir, 'test.pids')

      writeFileSync(targetPath, '12345\tcopilot\tMon Jan 1 00:00:00 2024\n')
      symlinkSync(targetPath, filePath)

      await expect(removePidEntry(filePath, 12345)).rejects.toThrow()

      expect(lstatSync(filePath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf-8')).toBe(
        '12345\tcopilot\tMon Jan 1 00:00:00 2024\n',
      )
    })

    it('rejects a symlinked parent directory in removePidEntry', async () => {
      const dir = makeTempDir()
      const realDir = join(dir, 'real-orphans')
      const linkedDir = join(dir, 'linked-orphans')
      const realFilePath = join(realDir, 'test.pids')
      const filePath = join(linkedDir, 'test.pids')

      mkdirSync(realDir, { mode: 0o700 })
      writeFileSync(realFilePath, '12345\tcopilot\tMon Jan 1 00:00:00 2024\n')
      symlinkSync(realDir, linkedDir)

      await expect(removePidEntry(filePath, 12345)).rejects.toThrow(
        /refusing symlink path/,
      )

      expect(lstatSync(linkedDir).isSymbolicLink()).toBe(true)
      expect(readFileSync(realFilePath, 'utf-8')).toBe(
        '12345\tcopilot\tMon Jan 1 00:00:00 2024\n',
      )
    })

    it('rejects a symlinked pid file in truncatePidFile', async () => {
      const dir = makeTempDir()
      const targetPath = join(dir, 'target.txt')
      const filePath = join(dir, 'test.pids')

      writeFileSync(targetPath, 'secret\n')
      symlinkSync(targetPath, filePath)

      await expect(truncatePidFile(filePath)).rejects.toThrow()

      expect(lstatSync(filePath).isSymbolicLink()).toBe(true)
      expect(readFileSync(targetPath, 'utf-8')).toBe('secret\n')
    })

    it('rejects a symlinked parent directory in unlinkPidFile', async () => {
      const dir = makeTempDir()
      const realDir = join(dir, 'real-orphans')
      const linkedDir = join(dir, 'linked-orphans')
      const realFilePath = join(realDir, 'test.pids')
      const filePath = join(linkedDir, 'test.pids')

      mkdirSync(realDir, { mode: 0o700 })
      writeFileSync(realFilePath, '12345\tcopilot\tMon Jan 1 00:00:00 2024\n')
      symlinkSync(realDir, linkedDir)

      await expect(unlinkPidFile(filePath)).rejects.toThrow(
        /refusing symlink path/,
      )

      expect(lstatSync(linkedDir).isSymbolicLink()).toBe(true)
      expect(existsSync(realFilePath)).toBe(true)
    })
  })

  describe('serialize lock interaction', () => {
    it('truncatePidFile and appendPidEntry serialize against each other', async () => {
      const dir = makeTempDir()
      const filePath = join(dir, 'concurrent.pids')

      // Seed: one entry already present
      await appendPidEntry(filePath, 1111, 'bash', 'Mon Apr 27 10:00:00 2026')

      // Concurrently fire append + truncate. Whichever queues first wins
      // on ordering, but neither must observe a torn write.
      await Promise.all([
        appendPidEntry(filePath, 2222, 'node', 'Mon Apr 27 10:00:01 2026'),
        truncatePidFile(filePath),
      ])

      const final = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''

      // Acceptable terminal states (any serial ordering of the two ops
      // over the seeded baseline produces one of these; no torn / partial
      // line is permitted):
      //   A) seed -> append -> truncate         => ''
      //   B) seed -> truncate -> append         => '2222\tnode\t...\n'
      const acceptable = new Set(['', '2222\tnode\tMon Apr 27 10:00:01 2026\n'])
      expect(acceptable.has(final)).toBe(true)
    })
  })
})
