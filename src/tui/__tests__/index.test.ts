import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  TuiCommand,
  TuiPluginApi,
  TuiPluginMeta,
  TuiToast,
} from '@opencode-ai/plugin/tui'
import { type JSX, testRender } from '@opentui/solid'

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

type ToastCall = {
  message: string
  variant?: string
  duration?: number
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
  clearCalls: number
  disposeHandlers: Array<() => void | Promise<void>>
  toastCalls: ToastCall[]
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
   *
   * Default `'command'` preserves the existing test suite's assertions about the
   * legacy `command.register` registration path without modification.
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
  const disposeHandlers: Array<() => void | Promise<void>> = []
  const toastCalls: ToastCall[] = []
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
      Dialog: ((props: { children?: JSX.Element }) =>
        props.children ?? null) as TuiPluginApi['ui']['Dialog'],
      DialogAlert: (() => null) as TuiPluginApi['ui']['DialogAlert'],
      DialogConfirm: (() => null) as TuiPluginApi['ui']['DialogConfirm'],
      DialogPrompt: (() => null) as TuiPluginApi['ui']['DialogPrompt'],
      DialogSelect: (() => null) as TuiPluginApi['ui']['DialogSelect'],
      Slot: (() => null) as TuiPluginApi['ui']['Slot'],
      Prompt: (() => null) as TuiPluginApi['ui']['Prompt'],
      toast: (input: TuiToast) => {
        toastCalls.push({
          message: input.message,
          variant: input.variant,
          duration: input.duration,
        })
      },
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
    get clearCalls() {
      return clearCalls
    },
    disposeHandlers,
    toastCalls,
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

async function waitForFrame(options: {
  renderOnce: () => Promise<void>
  idle: () => Promise<void>
  captureCharFrame: () => string
  includes: string
  attempts?: number
}): Promise<string> {
  const attempts = options.attempts ?? 10

  for (let index = 0; index < attempts; index += 1) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await options.renderOnce()
    await options.idle()
    await options.renderOnce()

    const frame = options.captureCharFrame()
    if (frame.includes(options.includes)) {
      return frame
    }
  }

  return options.captureCharFrame()
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
  it('registers /copilot-status using the value field', async () => {
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

  it('opens the modal list and loads tasks when /copilot-status is selected', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
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

    const stubFetch = Object.assign(
      async (input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        fetchCalls.push({
          url: String(input),
          authorization: headers.get('Authorization') ?? undefined,
          body: typeof init?.body === 'string' ? init.body : undefined,
        })

        return new Response(JSON.stringify({ tasks: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      { preconnect: originalFetch.preconnect },
    )

    globalThis.fetch = stubFetch as unknown as typeof fetch

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['large'])

    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => controls.dialogReplacements[0].render(),
      { useThread: false },
    )
    await renderOnce()

    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: '0 running · 0 recent',
    })
    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:43123/tasks/list',
        authorization: 'Bearer token-index-open',
        body: '{}',
      },
    ])
    expect(frame).toContain('0 running · 0 recent')
    expect(frame).toContain('No Copilot delegations are running.')
    expect(frame).not.toContain('Unit 6')
  })

  it('does not pass a re-entrant host onClose callback to the custom status dialog', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogReplacements[0].onClose).toBeUndefined()
    expect(controls.clearCalls).toBe(0)
  })

  it('does not toast when rpc is unavailable', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
    const cacheHome = makeCacheHome()
    process.env.XDG_CACHE_HOME = cacheHome
    process.env.OPENCODE_SESSION_ID = 'tui-index-error'

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['large'])

    const { renderOnce, renderer } = await testRender(
      () => controls.dialogReplacements[0].render(),
      { useThread: false },
    )

    await renderOnce()
    await renderer.idle()
    await renderOnce()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['large'])
    expect(controls.toastCalls).toEqual([])
  })

  it('prefers api.keymap.registerLayer when available (OpenCode 1.14.44+)', async () => {
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
    expect(controls.disposeHandlers).toHaveLength(1)

    // Dispose unregisters via the command-register path, mirroring the
    // keymap-path test's assertion that the correct teardown route runs.
    await controls.disposeHandlers[0]()
    expect(controls.unregisterCalls).toBe(1)
    expect(controls.keymapUnregisterCalls).toBe(0)
  })

  it('opens the modal list when the keymap-path command is run', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi({ surfaces: 'keymap' })

    await plugin(controls.api, undefined, makePluginMeta())

    const command = controls.keymapLayerCalls[0]?.commands[0] as
      | (Record<string, unknown> & { run?: () => void })
      | undefined
    expect(command).toBeDefined()
    command?.run?.()

    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['large'])
  })

  it('keeps /copilot-status on a single read-only dialog replacement', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
    const cacheHome = makeCacheHome()
    const sessionDiscriminator = 'tui-index-read-only'

    process.env.XDG_CACHE_HOME = cacheHome
    process.env.OPENCODE_SESSION_ID = sessionDiscriminator

    writePortFile(cacheHome, sessionDiscriminator, {
      port: 43124,
      pid: process.pid,
      token: 'token-index-read-only',
    })

    const stubFetch = Object.assign(
      async (_input: string | URL | Request) => {
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
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
      { preconnect: originalFetch.preconnect },
    )

    globalThis.fetch = stubFetch as unknown as typeof fetch

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()

    expect(controls.dialogReplacements).toHaveLength(1)

    const listRender = await testRender(
      () => controls.dialogReplacements[0].render(),
      {
        width: 120,
        height: 20,
        useThread: false,
      },
    )

    await listRender.renderOnce()

    const listFrame = await waitForFrame({
      renderOnce: listRender.renderOnce,
      idle: () => listRender.renderer.idle(),
      captureCharFrame: listRender.captureCharFrame,
      includes: '2 running · 0 recent',
    })
    expect(listFrame).toContain('cpl_beta')
    expect(listFrame).toContain('Esc close')
    expect(listFrame).not.toContain('navigate')
    expect(listFrame).not.toContain('c cancel')
    expect(controls.dialogReplacements).toHaveLength(1)
    expect(controls.dialogSizes).toEqual(['large'])
  })
})
