import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('opens the confirm card for the selected task when c is pressed in the modal list', async () => {
    const plugin = await loadTuiPlugin()
    const controls = createTestApi()
    const cacheHome = makeCacheHome()
    const sessionDiscriminator = 'tui-index-confirm-card'

    process.env.XDG_CACHE_HOME = cacheHome
    process.env.OPENCODE_SESSION_ID = sessionDiscriminator

    writePortFile(cacheHome, sessionDiscriminator, {
      port: 43124,
      pid: process.pid,
      token: 'token-index-confirm-card',
    })

    const stubFetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body === 'string' && init.body.includes('taskId')) {
          return new Response(JSON.stringify({ cancelled: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

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

    listRender.mockInput.pressKey('j')
    await waitForFrame({
      renderOnce: listRender.renderOnce,
      idle: () => listRender.renderer.idle(),
      captureCharFrame: listRender.captureCharFrame,
      includes: 'cpl_beta',
    })
    listRender.mockInput.pressKey('c')
    await waitForFrame({
      renderOnce: listRender.renderOnce,
      idle: () => listRender.renderer.idle(),
      captureCharFrame: listRender.captureCharFrame,
      includes: 'cpl_beta',
    })

    expect(controls.dialogReplacements).toHaveLength(2)

    const confirmRender = await testRender(
      () => controls.dialogReplacements[1].render(),
      {
        width: 120,
        height: 20,
        useThread: false,
      },
    )

    await confirmRender.renderOnce()

    const confirmFrame = await waitForFrame({
      renderOnce: confirmRender.renderOnce,
      idle: () => confirmRender.renderer.idle(),
      captureCharFrame: confirmRender.captureCharFrame,
      includes: 'Cancel Copilot delegation cpl_beta?',
    })

    expect(confirmFrame).toContain('Cancel Copilot delegation cpl_beta?')
    expect(confirmFrame).toContain('Cancel Task')
    expect(confirmFrame).toContain('Keep Running')
  })
})
