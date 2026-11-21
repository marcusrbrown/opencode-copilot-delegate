import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@opencode/plugin/tui'
import type { TuiPluginApi, TuiPluginMeta } from '@opencode-ai/plugin/tui'
import { serverPidDiscriminator } from '../../runtime/rpc-paths'
import { startRpcServer } from '../../runtime/rpc-server'

type V2Entry = {
  id: string
  tui: (api: TuiPluginApi, options: unknown, meta: TuiPluginMeta) => unknown
  setup: Plugin.Definition['setup']
}

type LayerCommand = {
  id?: string
  title?: string
  description?: string
  group?: string
  palette?: true
  slash?: { name: string }
  run: (input?: string) => unknown
}

type Pending = {
  kind: 'select' | 'confirm' | 'alert'
  options: Record<string, unknown>
  settle: (value: unknown) => void
}

const originalFetch = globalThis.fetch
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalSessionId = process.env.OPENCODE_SESSION_ID
const tempPaths: string[] = []
const cleanups: Array<() => Promise<void>> = []

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  setEnv('XDG_CACHE_HOME', originalXdgCacheHome)
  setEnv('OPENCODE_SESSION_ID', originalSessionId)

  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

async function loadEntry(): Promise<V2Entry> {
  await import('@opentui/solid/runtime-plugin-support')

  const module = await import('../index')

  return Reflect.get(module, 'default') as V2Entry
}

function makeTempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(path)
  return path
}

function createV2Context(options: {
  serverInfo?: () => Promise<{ pid: number }>
}) {
  const layers: Array<
    () => { mode?: string; commands?: readonly LayerCommand[] }
  > = []
  const dialogs: Pending[] = []
  let clearCalls = 0
  let showCalls = 0

  const open = (
    kind: Pending['kind'],
    dialogOptions: Record<string, unknown>,
  ) =>
    new Promise<unknown>((resolve) => {
      dialogs.at(-1)?.settle(undefined)
      dialogs.push({ kind, options: dialogOptions, settle: resolve })
    })

  const ctx = {
    client: {
      server: {
        info:
          options.serverInfo ??
          (async () => {
            throw new Error('server.info was not expected')
          }),
      },
    },
    keymap: {
      layer: (
        factory: () => { mode?: string; commands?: readonly LayerCommand[] },
      ) => {
        layers.push(factory)
      },
    },
    ui: {
      dialog: {
        select: (o: Record<string, unknown>) => open('select', o),
        confirm: (o: Record<string, unknown>) => open('confirm', o),
        alert: (o: Record<string, unknown>) => open('alert', o),
        set: () => {},
        clear: () => {
          clearCalls += 1
        },
        show: () => {
          showCalls += 1
        },
      },
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    layers,
    dialogs,
    get clearCalls() {
      return clearCalls
    },
    get showCalls() {
      return showCalls
    },
    command(): LayerCommand {
      const command = layers[0]?.().commands?.[0]
      if (!command) throw new Error('no command registered')
      return command
    },
  }
}

// Yields macrotask turns until `done()` holds. This bounds the wait by turns
// (a real HTTP round trip needs several), never by a wall-clock assertion.
async function flush(done?: () => boolean) {
  const turns = done ? 500 : 20

  for (let index = 0; index < turns && !done?.(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

function writePortFile(
  cacheHome: string,
  discriminator: string,
  contents: unknown,
) {
  const dir = join(cacheHome, 'opencode', 'copilot-delegate', discriminator)

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'server-port.json'), JSON.stringify(contents))
}

describe('tui entrypoint (OpenCode V2)', () => {
  it('exports one default carrying id, tui (V1) and setup (V2), and never server', async () => {
    const entry = await loadEntry()

    expect(Object.keys(entry).sort()).toEqual(['id', 'setup', 'tui'])
    expect(entry.id).toBe('opencode-copilot-delegate')
    expect(typeof entry.tui).toBe('function')
    expect(typeof entry.setup).toBe('function')
  })

  it('registers exactly one palette and slash command, copilot-status', async () => {
    const entry = await loadEntry()
    const host = createV2Context({})

    const cleanup = await entry.setup(host.ctx)

    expect(host.layers).toHaveLength(1)

    const layer = host.layers[0]()
    // `global`, or the command is unreachable from the focused prompt.
    expect(layer.mode).toBe('global')
    expect(layer.commands).toHaveLength(1)
    expect(host.command()).toMatchObject({
      id: 'copilot-status',
      title: 'Copilot Status',
      description: 'Show running Copilot delegations',
      group: 'Copilot',
      palette: true,
      slash: { name: 'copilot-status' },
    })
    expect(typeof host.command().run).toBe('function')
    expect(typeof cleanup).toBe('function')
    expect(host.dialogs).toHaveLength(0)

    await (cleanup as () => Promise<void> | void)()
  })

  it('finds the server port file by the server pid, not by OPENCODE_SESSION_ID', async () => {
    const entry = await loadEntry()
    // Mirrors the V2 server: it keys its port file by its own pid.
    const serverPid = process.pid
    const cacheHome = makeTempDir('copilot-status-v2-cache-')
    const discriminator = serverPidDiscriminator(serverPid)

    expect(discriminator).toBe(String(serverPid))

    const server = await startRpcServer({
      taskRegistry: {
        getAllTasks: () => [
          {
            taskId: 'cpl_live',
            status: 'running',
            agentName: 'reviewer',
            modelName: 'gpt-5',
            startedAt: 0,
          },
        ],
      },
      cancelTaskById: () => ({ cancelled: true }),
      portFileBaseDir: join(cacheHome, 'opencode', 'copilot-delegate'),
      sessionDiscriminator: discriminator,
    })
    cleanups.push(() => server.close())

    // The TUI process has a different session environment from the server.
    process.env.XDG_CACHE_HOME = cacheHome
    process.env.OPENCODE_SESSION_ID = 'ses_unrelated_to_the_server'

    const host = createV2Context({
      serverInfo: async () => ({ pid: serverPid }),
    })
    const cleanup = await entry.setup(host.ctx)

    host.command().run()
    await flush(() => host.dialogs.length > 0)

    // A real HTTP round trip against the real server answered the list call.
    expect(host.dialogs).toHaveLength(1)
    expect(host.dialogs[0]?.kind).toBe('select')
    const options = host.dialogs[0]?.options.options as Array<{
      value: string
    }>
    expect(options.map((option) => option.value)).toEqual(['cpl_live'])

    await (cleanup as () => Promise<void> | void)()
  })

  it('resolves the server pid on every open, so a restarted service is followed', async () => {
    const entry = await loadEntry()
    const cacheHome = makeTempDir('copilot-status-v2-restart-')
    const pids = [4101, 4102]
    const fetched: string[] = []

    process.env.XDG_CACHE_HOME = cacheHome
    for (const [index, pid] of pids.entries()) {
      writePortFile(cacheHome, String(pid), {
        port: 43200 + index,
        pid,
        token: `token-${pid}`,
      })
    }

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        fetched.push(String(input))
        return new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    let call = 0
    const host = createV2Context({
      serverInfo: async () => ({
        pid: pids[Math.min(call++, pids.length - 1)],
      }),
    })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => fetched.length >= 1)
    host.command().run()
    await flush(() => fetched.length >= 2)

    expect(fetched).toEqual([
      'http://127.0.0.1:43200/tasks/list',
      'http://127.0.0.1:43201/tasks/list',
    ])
  })

  it('renders the error state, without throwing, when the server cannot be identified', async () => {
    const entry = await loadEntry()
    const host = createV2Context({
      serverInfo: async () => {
        throw new Error('connection refused')
      },
    })
    const cleanup = await entry.setup(host.ctx)

    expect(() => host.command().run()).not.toThrow()
    await flush(() => host.dialogs.length > 0)

    expect(host.dialogs).toHaveLength(1)
    expect(host.dialogs[0]?.kind).toBe('alert')
    expect(host.dialogs[0]?.options.title).toBe('Status unavailable.')
    expect(String(host.dialogs[0]?.options.message)).toContain(
      'connection refused',
    )

    await (cleanup as () => Promise<void> | void)()
  })

  it('renders the error state when the port file is missing', async () => {
    const entry = await loadEntry()

    process.env.XDG_CACHE_HOME = makeTempDir('copilot-status-v2-empty-')

    const host = createV2Context({ serverInfo: async () => ({ pid: 4242 }) })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => host.dialogs.length > 0)

    expect(host.dialogs[0]?.kind).toBe('alert')
    expect(String(host.dialogs[0]?.options.message)).toContain(
      'port file is unavailable',
    )
  })

  it('does not read a local port file when the server runs on another machine', async () => {
    const entry = await loadEntry()
    const cacheHome = makeTempDir('copilot-status-v2-remote-')
    const fetched: string[] = []

    process.env.XDG_CACHE_HOME = cacheHome
    // An unrelated local server whose pid collides with the remote one.
    writePortFile(cacheHome, '4500', { port: 43500, pid: 4500, token: 't' })
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        fetched.push(String(input))
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    const host = createV2Context({
      serverInfo: async () =>
        ({ pid: 4500, hostname: 'remote-box.example' }) as { pid: number },
    })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => host.dialogs.length > 0)

    expect(fetched).toEqual([])
    expect(host.dialogs[0]?.kind).toBe('alert')
    expect(host.dialogs[0]?.options.title).toBe('Status unavailable.')
    expect(String(host.dialogs[0]?.options.message)).toContain(
      'only available for a local server',
    )
  })

  it('uses the local port file when the server reports this machine', async () => {
    const entry = await loadEntry()
    const cacheHome = makeTempDir('copilot-status-v2-samehost-')
    const fetched: string[] = []

    process.env.XDG_CACHE_HOME = cacheHome
    writePortFile(cacheHome, '4600', { port: 43600, pid: 4600, token: 't' })
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        fetched.push(String(input))
        return new Response(JSON.stringify({ tasks: [] }), { status: 200 })
      },
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    const host = createV2Context({
      serverInfo: async () =>
        ({ pid: 4600, hostname: hostname() }) as { pid: number },
    })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => fetched.length > 0)

    expect(fetched).toEqual(['http://127.0.0.1:43600/tasks/list'])
  })

  it('rejects a server pid that is not a positive integer', async () => {
    const entry = await loadEntry()
    const host = createV2Context({
      serverInfo: async () => ({ pid: '../escape' as unknown as number }),
    })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => host.dialogs.length > 0)

    expect(host.dialogs[0]?.kind).toBe('alert')
    expect(String(host.dialogs[0]?.options.message)).toContain(
      'did not report a usable pid',
    )
  })

  it('opens the list and closes on Esc without any plugin-initiated clear', async () => {
    const entry = await loadEntry()
    const cacheHome = makeTempDir('copilot-status-v2-esc-')

    process.env.XDG_CACHE_HOME = cacheHome
    writePortFile(cacheHome, '4300', { port: 43300, pid: 4300, token: 't' })
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            tasks: [
              {
                taskId: 'cpl_esc',
                status: 'running',
                agent: 'default',
                model: 'gpt-5',
                elapsedMs: 0,
                toolCallCount: 0,
                startedAt: 0,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    const host = createV2Context({ serverInfo: async () => ({ pid: 4300 }) })
    await entry.setup(host.ctx)

    host.command().run()
    await flush(() => host.dialogs.length > 0)
    host.dialogs.at(-1)?.settle(undefined)
    await flush()

    expect(host.dialogs).toHaveLength(1)
    expect(host.clearCalls).toBe(0)
    expect(host.showCalls).toBe(0)
  })

  it('stops the flow when the host runs the cleanup', async () => {
    const entry = await loadEntry()
    const cacheHome = makeTempDir('copilot-status-v2-cleanup-')

    process.env.XDG_CACHE_HOME = cacheHome
    writePortFile(cacheHome, '4400', { port: 43400, pid: 4400, token: 't' })
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    const host = createV2Context({ serverInfo: async () => ({ pid: 4400 }) })
    const cleanup = await entry.setup(host.ctx)

    host.command().run()
    await (cleanup as () => Promise<void> | void)()
    await flush()

    expect(host.dialogs).toHaveLength(0)
  })

  it('leaves the V1 tui entry on its own ladder: registerLayer is used and keymap.layer is never called', async () => {
    const entry = await loadEntry()
    const registerLayerCalls: unknown[] = []
    let layerCalls = 0
    const disposers: Array<() => void | Promise<void>> = []
    const api = {
      keymap: {
        registerLayer: (layer: unknown) => {
          registerLayerCalls.push(layer)
          return () => {}
        },
        layer: () => {
          layerCalls += 1
        },
      },
      ui: {},
      lifecycle: {
        onDispose: (fn: () => void | Promise<void>) => {
          disposers.push(fn)
          return () => {}
        },
      },
    } as unknown as TuiPluginApi

    await entry.tui(api, undefined, {} as TuiPluginMeta)

    expect(registerLayerCalls).toHaveLength(1)
    expect(layerCalls).toBe(0)
    expect(disposers).toHaveLength(1)
  })
})
