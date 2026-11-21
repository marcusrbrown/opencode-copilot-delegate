import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
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
import { PortFileSchema } from '../src/runtime/rpc-contract'
import { cleanupAll } from '../src/runtime/task-registry'
import { overrideEnv } from './helpers/env'

const tempPaths: string[] = []
const ENV_KEYS = [
  'HOME',
  'XDG_CACHE_HOME',
  'OPENCODE_SESSION_ID',
  'XDG_STATE_HOME',
] as const
// Snapshot at module load so afterAll can prove nothing leaked past the suite.
const envAtLoad = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
)
let restoreEnv: (() => void) | undefined
let closeRpcServer: (() => Promise<void>) | undefined

beforeEach(() => {
  // Each lifecycle test asserts side effects of a fresh `await plugin(input)`
  // (orphans-dir creation, foreign-pidfile reaping). Reset BEFORE each test so
  // singleton state from a previous test file (e.g. `tests/tools.test.ts`)
  // cannot short-circuit init and serve stale cached hooks tied to a different
  // XDG_STATE_HOME.
  _resetPluginSingleton()

  const homeDir = mkdtempSync(join(tmpdir(), 'plugin-init-home-'))
  const xdgCacheHome = mkdtempSync(join(tmpdir(), 'plugin-init-cache-'))
  tempPaths.push(homeDir)
  tempPaths.push(xdgCacheHome)
  restoreEnv = overrideEnv(ENV_KEYS, {
    HOME: homeDir,
    XDG_CACHE_HOME: xdgCacheHome,
    OPENCODE_SESSION_ID: 'index-test-session',
  })
  closeRpcServer = undefined
})

afterEach(async () => {
  await closeRpcServer?.()

  await cleanupAll()

  // Restore with delete-when-unset: assigning `undefined` would store the
  // string "undefined" and poison later suites (relative cache paths).
  restoreEnv?.()
  restoreEnv = undefined

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

afterAll(() => {
  for (const key of ENV_KEYS) {
    expect(process.env[key]).toBe(envAtLoad[key])
    expect(key in process.env).toBe(envAtLoad[key] !== undefined)
  }
})

function makePluginInput(directory: string): PluginInput {
  const input = {
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

  Object.defineProperty(input, '__captureRpcCleanup', {
    value: (cleanup: () => Promise<void>) => {
      closeRpcServer = cleanup
    },
  })

  return input
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
      'copilot_resume',
    ])
  })

  it('starts the RPC server during plugin init and cleans it up on beforeExit', async () => {
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-init-rpc-xdg-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState

    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    const portFilePath = join(
      process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? '', '.cache'),
      'opencode',
      'copilot-delegate',
      process.env.OPENCODE_SESSION_ID ?? '',
      'server-port.json',
    )

    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
      'copilot_resume',
    ])
    // Regression (#573): the port file must land in the temp cache, never in
    // the developer's real ~/.cache/opencode/copilot-delegate.
    expect(portFilePath.startsWith(tmpdir())).toBe(true)
    expect(existsSync(portFilePath)).toBe(true)
    expect(
      PortFileSchema.parse(JSON.parse(readFileSync(portFilePath, 'utf8'))),
    ).toEqual({
      port: expect.any(Number),
      pid: process.pid,
      token: expect.any(String),
    })

    await closeRpcServer?.()

    expect(existsSync(portFilePath)).toBe(false)
  })

  it('returns tools when RPC startup fails', async () => {
    const xdgCacheFile = join(
      process.env.XDG_CACHE_HOME ?? process.env.HOME ?? tmpdir(),
      'cache-file',
    )
    writeFileSync(xdgCacheFile, 'not a directory')
    process.env.XDG_CACHE_HOME = xdgCacheFile

    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
      'copilot_resume',
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
      'copilot_resume',
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

  it('returns empty hooks on duplicate factory invocations in the same process', async () => {
    // Regression for the dual-source registration bug: when OpenCode
    // invokes the plugin factory twice in the same PID (because the same
    // plugin is listed in BOTH a user-level and a project-level
    // opencode.json), the host iterates each invocation's returned hook
    // surface and registers every tool entry it finds — even when both
    // calls return the same JS reference. Returning the cached real hooks
    // on the duplicate path causes copilot_delegate / copilot_output /
    // copilot_cancel to appear twice in the LLM-visible tool catalog.
    //
    // The fix: the duplicate caller receives `{}` from `plugInOnce`, the
    // factory unwraps `result.hooks`, and the host registers nothing for
    // the duplicate source. This test asserts that exact contract at the
    // factory boundary so a future refactor cannot silently regress to
    // whole-hooks reuse.
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-init-dup-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState

    const input = makePluginInput(process.cwd())
    const first = await plugin(input)
    const second = await plugin(input)
    const third = await plugin(input)

    // First invocation gets the real hooks with the full tool catalog.
    expect(Object.keys(first.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
      'copilot_resume',
    ])

    // Duplicate invocations get an empty hooks object — `tool` is absent
    // entirely, not just empty. The host has nothing to register.
    expect(second).toEqual({})
    expect(second.tool).toBeUndefined()
    expect(third).toEqual({})
    expect(third.tool).toBeUndefined()

    // The first hooks reference is NOT shared with the duplicates: the
    // real hooks object stays attached to its first registration only.
    expect(second).not.toBe(first)
    expect(third).not.toBe(first)
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
      'copilot_resume',
    ])
    expect(lstatSync(linkedPluginStateDir).isSymbolicLink()).toBe(true)
    expect(readFileSync(foreignPidFile, 'utf-8')).toBe(
      '99999\tcopilot\tTue Apr 28 23:45:30 2026\n',
    )
  })
})

describe('per-workspace hooks (#530 item 2)', () => {
  function makeWorkspace(agentName: string): string {
    const dir = mkdtempSync(join(tmpdir(), `plugin-ws-${agentName}-`))
    tempPaths.push(dir)
    mkdirSync(join(dir, '.github', 'agents'), { recursive: true })
    writeFileSync(
      join(dir, '.github', 'agents', `${agentName}.md`),
      `---\nname: ${agentName}\ndescription: ${agentName} agent\n---\nbody\n`,
    )
    return dir
  }

  function readPortFileToken(): string {
    const portFilePath = join(
      process.env.XDG_CACHE_HOME ?? '',
      'opencode',
      'copilot-delegate',
      process.env.OPENCODE_SESSION_ID ?? '',
      'server-port.json',
    )
    return PortFileSchema.parse(JSON.parse(readFileSync(portFilePath, 'utf8')))
      .token
  }

  it('gives each workspace directory its own tools, bound to that directory', async () => {
    // Given two workspaces, each with a distinct repo-level Copilot agent
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-ws-xdg-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState
    const alpha = makeWorkspace('alpha-agent')
    const beta = makeWorkspace('beta-agent')

    // When the host invokes the factory once per workspace
    const first = await plugin(makePluginInput(alpha))
    const second = await plugin(makePluginInput(beta))

    // Then both get the full tool catalog (previously the second got `{}`)
    const tools = [
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
      'copilot_resume',
    ]
    expect(Object.keys(first.tool ?? {}).sort()).toEqual(tools)
    expect(Object.keys(second.tool ?? {}).sort()).toEqual(tools)

    // And each delegate tool discovered its own workspace's agents
    const alphaDescription = first.tool?.copilot_delegate.description ?? ''
    const betaDescription = second.tool?.copilot_delegate.description ?? ''
    expect(alphaDescription).toContain('alpha-agent')
    expect(alphaDescription).not.toContain('beta-agent')
    expect(betaDescription).toContain('beta-agent')
    expect(betaDescription).not.toContain('alpha-agent')
  })

  it('runs process setup once: one RPC server and port file for every workspace', async () => {
    // Given the factory invoked for a first workspace
    const xdgState = mkdtempSync(join(tmpdir(), 'plugin-ws-rpc-xdg-'))
    tempPaths.push(xdgState)
    process.env.XDG_STATE_HOME = xdgState
    await plugin(makePluginInput(makeWorkspace('one')))
    const firstCleanup = closeRpcServer
    expect(firstCleanup).toBeDefined()
    const tokenAfterFirst = readPortFileToken()

    // When further workspaces load the plugin in the same process
    closeRpcServer = undefined
    await plugin(makePluginInput(makeWorkspace('two')))
    await plugin(makePluginInput(makeWorkspace('three')))

    // Then no second server started: no new cleanup was wired, and the port
    // file still carries the first server's token
    expect(closeRpcServer).toBeUndefined()
    expect(readPortFileToken()).toBe(tokenAfterFirst)
    closeRpcServer = firstCleanup
  })
})
