import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  defaultPortFileBaseDir,
  defaultSessionDiscriminator,
} from '../src/runtime/rpc-paths'

const ENV_KEYS = ['XDG_CACHE_HOME', 'HOME', 'OPENCODE_SESSION_ID'] as const

const originalEnv = new Map<string, string | undefined>()

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key)
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key])
  }
})

afterEach(() => {
  restoreEnv()
})

describe('defaultPortFileBaseDir', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    process.env.XDG_CACHE_HOME = '/tmp/xdg-cache'
    process.env.HOME = '/tmp/ignored-home'

    expect(defaultPortFileBaseDir()).toBe(
      join('/tmp/xdg-cache', 'opencode', 'copilot-delegate'),
    )
  })

  it('falls back to HOME/.cache when XDG_CACHE_HOME is unset', () => {
    delete process.env.XDG_CACHE_HOME
    process.env.HOME = '/tmp/fake-home'

    expect(defaultPortFileBaseDir()).toBe(
      join('/tmp/fake-home', '.cache', 'opencode', 'copilot-delegate'),
    )
  })

  it('falls back to os.homedir()/.cache when XDG_CACHE_HOME and HOME are unset', () => {
    delete process.env.XDG_CACHE_HOME
    delete process.env.HOME

    expect(defaultPortFileBaseDir()).toBe(
      join(homedir(), '.cache', 'opencode', 'copilot-delegate'),
    )
  })
})

describe('defaultSessionDiscriminator', () => {
  it('uses OPENCODE_SESSION_ID when set', () => {
    process.env.OPENCODE_SESSION_ID = 'ses_test'

    expect(defaultSessionDiscriminator()).toBe('ses_test')
  })

  it('falls back to the process id when OPENCODE_SESSION_ID is unset', () => {
    delete process.env.OPENCODE_SESSION_ID

    expect(defaultSessionDiscriminator()).toBe(String(process.pid))
  })
})
