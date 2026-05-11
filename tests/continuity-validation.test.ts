import { describe, expect, it } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  validateAddDirs,
  validateCwd,
  validateTargetId,
} from '../src/runtime/continuity-validation'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'continuity-validation-'))
}

const uuid = '123e4567-e89b-12d3-a456-426614174000'
const uuidUpper = '123E4567-E89B-12D3-A456-426614174000'

describe('continuity-validation', () => {
  describe('validateTargetId', () => {
    it('should return a uuid target for UUID-shaped values', () => {
      expect(validateTargetId(uuid)).toEqual({ type: 'uuid', value: uuid })
    })

    it('should canonicalize uppercase UUID to lowercase', () => {
      expect(validateTargetId(uuidUpper)).toEqual({
        type: 'uuid',
        value: uuid,
      })
    })

    it('should return a name target for safe names', () => {
      expect(validateTargetId('session.name-1')).toEqual({
        type: 'name',
        value: 'session.name-1',
      })
    })

    it('should reject path traversal targets', () => {
      expect(validateTargetId('../../etc/passwd')).toEqual({
        error: 'invalid target ID format',
      })
    })

    it('should reject targets longer than the length cap', () => {
      expect(validateTargetId('a'.repeat(200))).toEqual({
        error: 'invalid target ID format',
      })
    })

    it('should reject plugin task IDs starting with cpl_ with an actionable error', () => {
      const result = validateTargetId('cpl_abc123')
      expect(result).toEqual({
        error:
          'Plugin task IDs (cpl_*) are not valid resume targets. Use copilot_output(task_id) to retrieve results, or pass the copilot_session_id from the completed task envelope.',
      })
    })

    it('should reject cpl_ IDs without spawning (no task_id in result)', () => {
      const result = validateTargetId(
        'cpl_123e4567-e89b-12d3-a456-426614174000',
      )
      expect('error' in result).toBe(true)
      expect('type' in result).toBe(false)
    })
  })

  describe('validateAddDirs', () => {
    it('should reject argv-injection-shaped values', () => {
      const root = makeTempDir()

      try {
        expect(validateAddDirs(['--allow-tool=shell(*)'], [root])).toEqual({
          error: 'argv-injection-shaped value in addDirs',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should reject paths outside allowed roots', () => {
      const root = makeTempDir()
      const outside = makeTempDir()

      try {
        expect(validateAddDirs([outside], [root])).toEqual({
          error: 'path outside allowed roots',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('should return resolved paths under allowed roots', () => {
      const root = makeTempDir()
      const child = join(root, 'sub')
      mkdirSync(child)

      try {
        expect(validateAddDirs([child], [root])).toEqual([
          realpathSync(resolve(child)),
        ])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should reject relative paths', () => {
      const root = makeTempDir()

      try {
        expect(validateAddDirs(['relative/path'], [root])).toEqual({
          error: 'path outside allowed roots',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should reject more than 32 entries', () => {
      const root = makeTempDir()

      try {
        expect(
          validateAddDirs(
            Array.from({ length: 33 }, () => root),
            [root],
          ),
        ).toEqual({
          error: 'too many addDirs',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('validateCwd', () => {
    it('should return a resolved path under allowed roots', () => {
      const root = makeTempDir()

      try {
        expect(validateCwd(root, [root])).toBe(realpathSync(resolve(root)))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should reject argv-injection-shaped cwd values', () => {
      const root = makeTempDir()

      try {
        expect(validateCwd('--cwd=/tmp', [root])).toEqual({
          error: 'argv-injection-shaped cwd',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should reject cwd outside allowed roots', () => {
      const root = makeTempDir()
      const outside = makeTempDir()

      try {
        expect(validateCwd(outside, [root])).toEqual({
          error: 'cwd outside allowed roots',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
        rmSync(outside, { recursive: true, force: true })
      }
    })

    it('should return structured error when cwd contains a symlink loop', () => {
      const root = makeTempDir()
      const linkPath = join(root, 'loop-link')
      symlinkSync(linkPath, linkPath)

      try {
        const result = validateCwd(linkPath, [root])
        expect(result).toEqual({ error: 'cwd outside allowed roots' })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })

  describe('validateAddDirs (realpath error handling)', () => {
    it('should return structured error when add_dir contains a symlink loop (ELOOP)', () => {
      const root = makeTempDir()
      const linkPath = join(root, 'loop-link')
      symlinkSync(linkPath, linkPath)

      try {
        const result = validateAddDirs([linkPath], [root])
        expect(result).toEqual({ error: 'path outside allowed roots' })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('should not throw when add_dir realpath fails', () => {
      const root = makeTempDir()
      const linkPath = join(root, 'loop2')
      symlinkSync(linkPath, linkPath)

      try {
        expect(() => validateAddDirs([linkPath], [root])).not.toThrow()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
})
