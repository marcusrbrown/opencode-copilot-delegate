import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  TuiCommand,
  TuiDialogSelectProps,
  TuiPluginApi,
  TuiPluginMeta,
} from '@opencode-ai/plugin/tui'
import type { JSX } from '@opentui/solid'

type TuiPlugin = (
  api: TuiPluginApi,
  options: unknown,
  meta: TuiPluginMeta,
) => Promise<void>

type TuiPluginModule = {
  id: string
  tui: TuiPlugin
}

type DialogReplacement = {
  render: () => JSX.Element
  onClose?: () => void
}

type KeymapLayerCall = {
  commands: ReadonlyArray<Record<string, unknown>>
  bindings: ReadonlyArray<unknown>
}

type TestApiControls = {
  api: TuiPluginApi
  commandFactories: Array<() => TuiCommand[]>
  dialogReplacements: DialogReplacement[]
  dialogSizes: Array<'medium' | 'large' | 'xlarge'>
  selectProps: TuiDialogSelectProps<string>[]
  clearCalls: number
  disposeHandlers: Array<() => void | Promise<void>>
  unregisterCalls: number
  keymapLayerCalls: KeymapLayerCall[]
  keymapUnregisterCalls: number
}

type CreateTestApiOptions = {
  /**
   * Which TUI registration surfaces the api stub exposes:
   * - `'command'` (default): only `api.command.register` — OpenCode 1.14.41 baseline
   * - `'keymap'`: only `api.keymap.registerLayer` — OpenCode 1.14.44+ canonical (and the 1.14.42–43 gap)
   * - `'both'`: both surfaces — the 1.14.44+ shim era where `command.register` is restored as a deprecated shim
   */
  surfaces?: 'command' | 'keymap' | 'both'
}

const originalFetch = globalThis.fetch
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalSessionId = process.env.OPENCODE_SESSION_ID
const tempPaths: string[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.XDG_CACHE_HOME = originalXdgCacheHome
  process.env.OPENCODE_SESSION_ID = originalSessionId

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

async function loadTuiPlugin(): Promise<TuiPlugin> {
  await import('@opentui/solid/runtime-plugin-support')

  const module = await import('../index')
  const pluginModule = Reflect.get(module, 'default') as TuiPluginModule
  const plugin = pluginModule.tui

  expect(pluginModule).toEqual({
    id: 'opencode-copilot-delegate',
    tui: expect.any(Function),
  })

  expect(typeof plugin).toBe('function')

  return plugin as TuiPlugin
}

function createTestApi(options: CreateTestApiOptions = {}): TestApiControls {
  const surfaces = options.surfaces ?? 'command'
  const exposeKeymap = surfaces === 'keymap' || surfaces === 'both'
  const exposeCommand = surfaces === 'command' || surfaces === 'both'

  const commandFactories: Array<() => TuiCommand[]> = []
  const dialogReplacements: DialogReplacement[] = []
  const dialogSizes: Array<'medium' | 'large' | 'xlarge'> = []
  const selectProps: TuiDialogSelectProps<string>[] = []
  const disposeHandlers: Array<() => void | Promise<void>> = []
  const keymapLayerCalls: KeymapLayerCall[] = []
  let clearCalls = 0
  let unregisterCalls = 0
  let keymapUnregisterCalls = 0

  const commandSurface = exposeCommand
    ? {
        register: (cb: () => TuiCommand[]) => {
          commandFactories.push(cb)
          return () => {
            unregisterCalls += 1
          }
        },
        trigger: () => {},
        show: () => {},
      }
    : undefined

  const keymapSurface = exposeKeymap
    ? {
        registerLayer: (layer: {
          commands: ReadonlyArray<Record<string, unknown>>
          bindings: ReadonlyArray<unknown>
        }) => {
          keymapLayerCalls.push({
            commands: layer.commands,
            bindings: layer.bindings,
          })
          return () => {
            keymapUnregisterCalls += 1
          }
        },
      }
    : undefined

  const api = {
    ...(commandSurface ? { command: commandSurface } : {}),
    ...(keymapSurface ? { keymap: keymapSurface } : {}),
    ui: {
      DialogAlert: (() => null) as TuiPluginApi['ui']['DialogAlert'],
      DialogConfirm: (() => null) as TuiPluginApi['ui']['DialogConfirm'],
      DialogSelect: ((props: TuiDialogSelectProps<string>) => {
        selectProps.push(props)
        return null
      }) as unknown as TuiPluginApi['ui']['DialogSelect'],
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          dialogReplacements.push({ render, onClose })
        },
        clear: () => {
          clearCalls += 1
        },
        setSize: (size: 'medium' | 'large' | 'xlarge') => {
          dialogSizes.push(size)
        },
        size: 'medium',
        depth: 0,
        open: false,
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (fn: () => void | Promise<void>) => {
        disposeHandlers.push(fn)
        return () => {}
      },
    },
  } as unknown as TuiPluginApi

  return {
    api,
    commandFactories,
    dialogReplacements,
    dialogSizes,
    selectProps,
    get clearCalls() {
      return clearCalls
    },
    disposeHandlers,
    get unregisterCalls() {
      return unregisterCalls
    },
    keymapLayerCalls,
    get keymapUnregisterCalls() {
      return keymapUnregisterCalls
    },
  }
}

function makeCacheHome(): string {
  const path = mkdtempSync(join(tmpdir(), 'copilot-status-index-'))
  tempPaths.push(path)
  return path
}

function writePortFile(
  cacheHome: string,
  sessionDiscriminator: string,
  contents: unknown,
) {
  const sessionDir = join(
    cacheHome,
    'opencode',
    'copilot-delegate',
    sessionDiscriminator,
  )

  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'server-port.json'), JSON.stringify(contents))
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function makePluginMeta(): TuiPluginMeta {
  return {
    id: 'copilot-status-test',
    source: 'npm',
    spec: 'opencode-copilot-delegate',
    target: '/tmp/opencode-copilot-delegate',
    requested: 'opencode-copilot-delegate',
    version: '0.9.0',
    modified: Date.now(),
    first_time: Date.now(),
    last_time: Date.now(),
    time_changed: Date.now(),
    load_count: 1,
    fingerprint: 'test-fingerprint',
    state: 'same',
  }
}

describe('tui entrypoint', () => {
  it('registers the slash command through the legacy command.register path with slash set', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()

    await plugin(controls.api, undefined, makePluginMeta())

    expect(controls.commandFactories).toHaveLength(1)
    expect(controls.disposeHandlers).toHaveLength(1)

    const commands = controls.commandFactories[0]()

    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      title: 'Copilot Status',
      value: '/copilot-status',
      slash: { name: 'copilot-status' },
    })

    await controls.disposeHandlers[0]()
    expect(controls.unregisterCalls).toBe(1)
  })

  it('registers a palette command with slashName and desc via api.keymap.registerLayer (OpenCode 1.14.44+)', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi({ surfaces: 'keymap' })

    await plugin(controls.api, undefined, makePluginMeta())

    expect(controls.keymapLayerCalls).toHaveLength(1)
    expect(controls.commandFactories).toHaveLength(0)

    const layer = controls.keymapLayerCalls[0]
    expect(layer.bindings).toEqual([])
    expect(layer.commands).toHaveLength(1)

    const command = layer.commands[0]
    expect(command).toMatchObject({
      namespace: 'palette',
      name: 'copilot-status',
      title: 'Copilot Status',
      category: 'Copilot',
      slashName: 'copilot-status',
      desc: 'Show running Copilot delegations',
    })
    expect(typeof command.run).toBe('function')

    expect(controls.disposeHandlers).toHaveLength(1)
    await controls.disposeHandlers[0]()
    expect(controls.keymapUnregisterCalls).toBe(1)
    expect(controls.unregisterCalls).toBe(0)
  })

  it('prefers api.keymap.registerLayer when both APIs exist (1.14.44+ shim era)', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi({ surfaces: 'both' })

    await plugin(controls.api, undefined, makePluginMeta())

    expect(controls.keymapLayerCalls).toHaveLength(1)
    expect(controls.commandFactories).toHaveLength(0)
  })

  it('falls back to api.command.register when keymap.registerLayer is absent (OpenCode 1.14.41)', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi({ surfaces: 'command' })

    await plugin(controls.api, undefined, makePluginMeta())

    expect(controls.commandFactories).toHaveLength(1)
    expect(controls.keymapLayerCalls).toHaveLength(0)

    await controls.disposeHandlers[0]()
    expect(controls.unregisterCalls).toBe(1)
    expect(controls.keymapUnregisterCalls).toBe(0)
  })

  it('opens a host DialogSelect with one option per task when the palette command runs', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi({ surfaces: 'keymap' })
    const cacheHome = makeCacheHome()
    const sessionDiscriminator = 'tui-index-open'
    const fetchCalls: Array<{
      url: string
      authorization?: string
      body?: string
    }> = []

    process.env.XDG_CACHE_HOME = cacheHome
    process.env.OPENCODE_SESSION_ID = sessionDiscriminator

    writePortFile(cacheHome, sessionDiscriminator, {
      port: 43123,
      pid: process.pid,
      token: 'token-index-open',
    })

    globalThis.fetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        fetchCalls.push({
          url: String(input),
          authorization: headers.get('Authorization') ?? undefined,
          body: typeof init?.body === 'string' ? init.body : undefined,
        })

        return new Response(
          JSON.stringify({
            tasks: [
              {
                taskId: 'cpl_alpha',
                status: 'running',
                agent: 'default',
                model: 'gpt-5',
                elapsedMs: 0,
                toolCallCount: 1,
                startedAt: 0,
              },
              {
                taskId: 'cpl_beta',
                status: 'running',
                agent: 'reviewer',
                model: 'claude-sonnet-4.7',
                elapsedMs: 0,
                toolCallCount: 2,
                startedAt: 0,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
      { preconnect: originalFetch.preconnect },
    ) as unknown as typeof fetch

    await plugin(controls.api, undefined, makePluginMeta())

    const command = controls.keymapLayerCalls[0]?.commands[0] as
      | (Record<string, unknown> & { run?: () => void })
      | undefined
    command?.run?.()
    await flush()

    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:43123/tasks/list',
        authorization: 'Bearer token-index-open',
        body: '{}',
      },
    ])
    expect(controls.dialogSizes).toEqual(['large'])
    expect(controls.dialogReplacements).toHaveLength(1)

    controls.dialogReplacements[0].render()
    expect(controls.selectProps).toHaveLength(1)
    expect(controls.selectProps[0].options.map((o) => o.value)).toEqual([
      'cpl_alpha',
      'cpl_beta',
    ])
  })

  it('shows an alert instead of throwing when rpc is unavailable', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
    process.env.XDG_CACHE_HOME = makeCacheHome()
    process.env.OPENCODE_SESSION_ID = 'tui-index-error'

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()
    await flush()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['medium'])
    expect(controls.dialogReplacements[0].onClose).toBeUndefined()
    expect(controls.clearCalls).toBe(0)
  })
})
