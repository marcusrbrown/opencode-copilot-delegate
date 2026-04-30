import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import plugin from '../src/index'
import { _resetPluginSingleton } from '../src/runtime/plugin-singleton'
import { cleanupAll } from '../src/runtime/task-registry'

const tempPaths: string[] = []
const originalXdgStateHome = process.env.XDG_STATE_HOME

beforeEach(() => {
  // Each lifecycle test asserts side effects of a fresh `await plugin(input)`
  // (orphans-dir creation, foreign-pidfile reaping). Reset BEFORE each test so
  // singleton state from a previous test file (e.g. `tests/tools.test.ts`)
  // cannot short-circuit init and serve stale cached hooks tied to a different
  // XDG_STATE_HOME.
  _resetPluginSingleton()
})

afterEach(async () => {
  await cleanupAll()

  process.env.XDG_STATE_HOME = originalXdgStateHome

  for (const tempPath of tempPaths.splice(0)) {
    try {
      // Restore writable mode so rmSync can clean up directories that the
      // failure-path test made unwritable.
      chmodSync(tempPath, 0o700)
    } catch {
      // best-effort
    }
    rmSync(tempPath, { force: true, recursive: true })
  }
})

function makePluginInput(directory: string): PluginInput {
  return {
    client: {
      session: {
        prompt: async () => {},
      },
      tui: {
        showToast: () => {},
      },
      app: {
        log: () => {},
      },
    } as unknown as PluginInput['client'],
    project: {
      id: 'project-1',
      name: 'project-1',
      root: directory,
      worktree: directory,
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    } as unknown as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: {
      register: () => {},
    },
    serverUrl: new URL('http://localhost:3000'),
    $: {} as PluginInput['$'],
  }
}

describe('plugin init lifecycle', () => {
  it('creates the orphans directory with mode 0o700', async () => {
    // Given a temp XDG_STATE_HOME so the plugin's PID-file dir lands in a
    // controlled location we can inspect after init.
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-init-xdg-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState

    // When the plugin is loaded
    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    // Then the orphans directory exists with restrictive permissions
    const orphansDir = join(xdgState, 'opencode-copilot-delegate', 'orphans')
    const stat = statSync(orphansDir)
    expect(stat.isDirectory()).toBe(true)

    // mode is the full st_mode field; mask to the permission bits to compare.
    // 0o700 is rwx for owner only.
    expect(stat.mode & 0o777).toBe(0o700)

    // And tools dispatch happened after reap (proves init ran to completion)
    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
    ])
  })

  it('returns tool dispatch when mkdir throws', async () => {
    // Given an XDG_STATE_HOME whose parent directory is read-only, so mkdir
    // for the orphans subdir fails with EACCES. The plugin's try/catch must
    // swallow the failure and still return tools.
    if (process.platform === 'win32') {
      // Windows does not honor POSIX chmod permission bits for this fixture.
      return
    }
    if (process.getuid?.() === 0) {
      // Root bypasses chmod permission checks, so EACCES never fires; skip.
      return
    }

    const parent = mkdtempSync(join(tmpdir(), 'plugin-init-readonly-'))
    tempPaths.push(parent)
    chmodSync(parent, 0o500) // r-x only — no write permission

    const xdgState = join(parent, 'state')
    process.env.XDG_STATE_HOME = xdgState

    // When the plugin is loaded
    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    // Then tools still dispatch (mkdir threw and was swallowed)
    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
    ])

    // And the orphans directory was NOT created (proves the failure path
    // was actually taken, not silently bypassed).
    const orphansDir = join(xdgState, 'opencode-copilot-delegate', 'orphans')
    expect(() => statSync(orphansDir)).toThrow()
  })

  it('completes orphan reaping before tool dispatch', async () => {
    // Seed a foreign dead-spawner pidfile in the exact orphans directory that
    // plugin init reaps. If init stops awaiting reapOrphans, the foreign file
    // will still exist after `await plugin(...)` resolves; the awaited path
    // must unlink it before returning the tool dispatch.
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-init-await-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState
    const orphansDir = join(xdgState, 'opencode-copilot-delegate', 'orphans')
    mkdirSync(orphansDir, { recursive: true, mode: 0o700 })

    const deadSpawnerPid = 4_194_305
    const foreignPidFile = join(orphansDir, `${deadSpawnerPid}.pids`)
    writeFileSync(
      foreignPidFile,
      `${deadSpawnerPid}\tcopilot\tTue Apr 28 23:45:30 2026\n`,
    )

    // When the plugin is loaded
    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    // Then init finished reaping before returning the tool dispatch.
    expect(statSync(orphansDir).isDirectory()).toBe(true)
    expect(() => statSync(foreignPidFile)).toThrow()

    // And tools dispatch is ready
    expect(result.tool).toBeDefined()
    expect(typeof result.tool?.copilot_delegate.execute).toBe('function')
  })

  it('returns tools without following a symlinked pid state parent into orphans', async () => {
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-init-symlink-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState

    const realPluginStateDir = join(xdgState, 'real-plugin-state')
    const realOrphansDir = join(realPluginStateDir, 'orphans')
    mkdirSync(realOrphansDir, { recursive: true, mode: 0o700 })

    const linkedPluginStateDir = join(xdgState, 'opencode-copilot-delegate')
    symlinkSync(realPluginStateDir, linkedPluginStateDir)

    const foreignPidFile = join(realOrphansDir, '4194305.pids')
    writeFileSync(foreignPidFile, '99999\tcopilot\tTue Apr 28 23:45:30 2026\n')

    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
    ])
    expect(lstatSync(linkedPluginStateDir).isSymbolicLink()).toBe(true)
    expect(readFileSync(foreignPidFile, 'utf-8')).toBe(
      '99999\tcopilot\tTue Apr 28 23:45:30 2026\n',
    )
  })
})
