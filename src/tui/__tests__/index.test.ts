import { afterEach, describe, expect, it } from 'bun:test'
import type {
  TuiCommand,
  TuiPluginApi,
  TuiPluginMeta,
} from '@opencode-ai/plugin/tui'
import { type JSX, testRender } from '@opentui/solid'

type TuiPlugin = (
  api: TuiPluginApi,
  options: unknown,
  meta: TuiPluginMeta,
) => Promise<void>

type DialogReplacement = {
  render: () => JSX.Element
  onClose?: () => void
}

type TestApiControls = {
  api: TuiPluginApi
  commandFactories: Array<() => TuiCommand[]>
  dialogReplacements: DialogReplacement[]
  disposeHandlers: Array<() => void | Promise<void>>
  unregisterCalls: number
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function loadTuiPlugin(): Promise<TuiPlugin> {
  await import('@opentui/solid/runtime-plugin-support')

  const module = await import('../index')
  const plugin = Reflect.get(module, 'default')

  expect(typeof plugin).toBe('function')

  return plugin as TuiPlugin
}

function createTestApi(): TestApiControls {
  const commandFactories: Array<() => TuiCommand[]> = []
  const dialogReplacements: DialogReplacement[] = []
  const disposeHandlers: Array<() => void | Promise<void>> = []
  let unregisterCalls = 0

  const api = {
    command: {
      register: (cb: () => TuiCommand[]) => {
        commandFactories.push(cb)
        return () => {
          unregisterCalls += 1
        }
      },
      trigger: () => {},
      show: () => {},
    },
    ui: {
      Dialog: ((props: { children?: JSX.Element }) =>
        props.children ?? null) as TuiPluginApi['ui']['Dialog'],
      DialogAlert: (() => null) as TuiPluginApi['ui']['DialogAlert'],
      DialogConfirm: (() => null) as TuiPluginApi['ui']['DialogConfirm'],
      DialogPrompt: (() => null) as TuiPluginApi['ui']['DialogPrompt'],
      DialogSelect: (() => null) as TuiPluginApi['ui']['DialogSelect'],
      Slot: (() => null) as TuiPluginApi['ui']['Slot'],
      Prompt: (() => null) as TuiPluginApi['ui']['Prompt'],
      toast: () => {},
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          dialogReplacements.push({ render, onClose })
        },
        clear: () => {},
        setSize: () => {},
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
    disposeHandlers,
    get unregisterCalls() {
      return unregisterCalls
    },
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

  it('opens a placeholder dialog without making network calls yet', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
    let fetchCalls = 0
    const unexpectedFetch = Object.assign(
      async () => {
        fetchCalls += 1
        throw new Error('unexpected fetch during placeholder open')
      },
      { preconnect: originalFetch.preconnect },
    )

    globalThis.fetch = unexpectedFetch as unknown as typeof fetch

    await plugin(controls.api, undefined, makePluginMeta())

    const [command] = controls.commandFactories[0]()
    command.onSelect?.()

    expect(fetchCalls).toBe(0)
    expect(controls.dialogReplacements).toHaveLength(1)

    const { renderOnce, captureCharFrame } = await testRender(() =>
      controls.dialogReplacements[0].render(),
    )
    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toContain('Copilot status')
    expect(frame).toContain('Unit 6')
  })
})
