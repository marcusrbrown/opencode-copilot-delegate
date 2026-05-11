import { describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  hasLocalCopilotSession,
  isCopilotSessionUuid,
  normalizeContinuityError,
  resolveConfigDir,
} from '../src/runtime/continuity-checks'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'continuity-checks-'))
}

const uuid = '123e4567-e89b-12d3-a456-426614174000'

describe('continuity-checks', () => {
  describe('resolveConfigDir', () => {
    it('should return the default Copilot config dir when no override is set', () => {
      const previous = process.env.COPILOT_CONFIG_DIR
      delete process.env.COPILOT_CONFIG_DIR

      try {
        expect(resolveConfigDir()).toBe(resolve(homedir(), '.copilot'))
      } finally {
        if (previous === undefined) delete process.env.COPILOT_CONFIG_DIR
        else process.env.COPILOT_CONFIG_DIR = previous
      }
    })

    it('should resolve an explicit config dir', () => {
      expect(resolveConfigDir('relative-copilot-config')).toBe(
        resolve('relative-copilot-config'),
      )
    })

    it('should honor COPILOT_CONFIG_DIR when no explicit config dir is provided', () => {
      const previous = process.env.COPILOT_CONFIG_DIR
      process.env.COPILOT_CONFIG_DIR = 'env-copilot-config'

      try {
        expect(resolveConfigDir()).toBe(resolve('env-copilot-config'))
      } finally {
        if (previous === undefined) delete process.env.COPILOT_CONFIG_DIR
        else process.env.COPILOT_CONFIG_DIR = previous
      }
    })
  })

  describe('hasLocalCopilotSession', () => {
    it('should return true when the local session database exists', async () => {
      const configDir = makeTempDir()
      const sessionDir = join(configDir, 'session-state', uuid)
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(join(sessionDir, 'session.db'), '')

      try {
        await expect(hasLocalCopilotSession(uuid, configDir)).resolves.toBe(
          true,
        )
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('should return false when the local session database is absent', async () => {
      const configDir = makeTempDir()

      try {
        await expect(hasLocalCopilotSession(uuid, configDir)).resolves.toBe(
          false,
        )
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('should return { error } on a non-ENOENT filesystem error (ENOTDIR)', async () => {
      const configDir = makeTempDir()
      // Place a regular file where the uuid directory would be, so stat of
      // `${uuid}/session.db` raises ENOTDIR instead of ENOENT.
      const sessionStateDir = join(configDir, 'session-state')
      mkdirSync(sessionStateDir, { recursive: true })
      writeFileSync(join(sessionStateDir, uuid), '')

      try {
        const result = await hasLocalCopilotSession(uuid, configDir)
        expect(result).toMatchObject({
          error: expect.stringContaining('ENOTDIR'),
        })
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    })

    it('should reject traversal-shaped session ids without probing outside session-state', async () => {
      const configDir = makeTempDir()
      const outsidePath = join(configDir, 'outside')
      writeFileSync(outsidePath, '')

      try {
        await expect(
          hasLocalCopilotSession('../outside', configDir),
        ).resolves.toBe(false)
        expect(existsSync(outsidePath)).toBe(true)
      } finally {
        rmSync(configDir, { recursive: true, force: true })
      }
    })
  })

  describe('isCopilotSessionUuid', () => {
    it('should return true for a UUID-shaped Copilot session id', () => {
      expect(isCopilotSessionUuid(uuid)).toBe(true)
    })

    it('should return false for a short hex prefix', () => {
      expect(isCopilotSessionUuid('123e4567')).toBe(false)
    })
  })

  describe('normalizeContinuityError', () => {
    it('should normalize Copilot no-match stderr into a clean message', () => {
      const stderr =
        "Error: No session, task, or name matched 'missing-session'\n"

      expect(normalizeContinuityError(stderr)).toBe(
        "No session, task, or name matched 'missing-session'",
      )
    })

    it('should return null for unrecognized stderr', () => {
      expect(
        normalizeContinuityError('Error: something else failed'),
      ).toBeNull()
    })
  })
})
