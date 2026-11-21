import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeSessionDiscriminator,
  defaultPortFileBaseDir,
  defaultSessionDiscriminator,
  discriminatorForServer,
  serverPidDiscriminator,
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

describe('serverPidDiscriminator', () => {
  it('accepts positive safe integers only', () => {
    expect(serverPidDiscriminator(4242)).toBe('4242')
    for (const bad of [0, -1, 1.5, Number.NaN, '12', null, undefined, {}]) {
      expect(serverPidDiscriminator(bad)).toBeUndefined()
    }
  })
})

describe('assertSafeSessionDiscriminator', () => {
  it('accepts a single path segment', () => {
    expect(() => assertSafeSessionDiscriminator('ses_abc-123')).not.toThrow()
    expect(() => assertSafeSessionDiscriminator('4242')).not.toThrow()
  })

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b'])('rejects %p', (bad) => {
    expect(() => assertSafeSessionDiscriminator(bad)).toThrow(
      'invalid session discriminator',
    )
  })
})

describe('discriminatorForServer', () => {
  it('keys a local server by its pid', () => {
    expect(
      discriminatorForServer({ pid: 77, hostname: 'box.local' }, 'box.local'),
    ).toBe('77')
  })

  it('compares hostnames case-insensitively', () => {
    expect(
      discriminatorForServer({ pid: 77, hostname: 'BOX.local' }, 'box.LOCAL'),
    ).toBe('77')
  })

  it('treats an absent hostname as local', () => {
    expect(discriminatorForServer({ pid: 77 }, 'box.local')).toBe('77')
  })

  it('defaults the local hostname to this machine', () => {
    expect(discriminatorForServer({ pid: 77, hostname: hostname() })).toBe('77')
  })

  it('refuses a server on another machine, without using its pid', () => {
    expect(() =>
      discriminatorForServer({ pid: 77, hostname: 'remote.example' }, 'box'),
    ).toThrow('status is only available for a local server')
    expect(() =>
      discriminatorForServer({ pid: 77, hostname: 'remote.example' }, 'box'),
    ).toThrow('remote.example')
  })

  it('refuses a server that reports no usable pid', () => {
    expect(() => discriminatorForServer({ pid: '../x' }, 'box')).toThrow(
      'did not report a usable pid',
    )
  })
})
