import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Plugin } from '@opencode/plugin'
import type { z } from 'zod'
import * as coreTools from '../src/core/tools'
import { buildTools } from '../src/core/tools'
import { setupV2, syntheticDelivery } from '../src/hosts/v2'
import plugin from '../src/index'
import { _resetPluginSingleton } from '../src/runtime/plugin-singleton'
import { PortFileSchema } from '../src/runtime/rpc-contract'
import { cleanupAll, getAllTasks } from '../src/runtime/task-registry'
import { overrideEnv } from './helpers/env'

type AddedTool = {
  name: string
  description: string
  input: z.ZodType
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>
}
type SyntheticCall = Record<string, unknown>

const ENV_KEYS = [
  'PATH',
  'HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_SESSION_ID',
] as const
const TOOL_NAMES = [
  'copilot_cancel',
  'copilot_delegate',
  'copilot_output',
  'copilot_resume',
]

const tempPaths: string[] = []
const cleanups: Array<() => Promise<void> | void> = []
let restoreEnv: (() => void) | undefined
let binDir = ''

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(dir)
  return dir
}

beforeEach(() => {
  _resetPluginSingleton()
  binDir = tempDir('host-v2-bin-')
  // Each prompt names a gate file; the fake CLI waits for `<prompt>.go`, so
  // the test, not a timer, decides when each task finishes. Prompts starting
  // with `fail` exit 1. `hang` never finishes on its own.
  writeFileSync(
    join(binDir, 'copilot'),
    `#!/usr/bin/env bash
prompt=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then shift; prompt="$1"; break; fi
  shift
done
gate="$(dirname "$0")/$prompt.go"
while [ ! -e "$gate" ]; do sleep 0.02; done
case "$prompt" in
  fail*) echo "boom" >&2; exit 1 ;;
esac
printf '%s\\n' '{"type":"assistant.message","data":{"messageId":"m","content":"done","toolRequests":[]}}'
printf '%s\\n' '{"type":"result","sessionId":"s","exitCode":0,"usage":{}}'
`,
  )
  chmodSync(join(binDir, 'copilot'), 0o755)
  restoreEnv = overrideEnv(ENV_KEYS, {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: tempDir('host-v2-home-'),
    XDG_CACHE_HOME: tempDir('host-v2-cache-'),
    XDG_STATE_HOME: tempDir('host-v2-state-'),
    OPENCODE_SESSION_ID: 'host-v2-session',
  })
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await cleanupAll()
  _resetPluginSingleton()
  restoreEnv?.()
  restoreEnv = undefined
  for (const p of tempPaths.splice(0))
    rmSync(p, { force: true, recursive: true })
})

function release(prompt: string): void {
  writeFileSync(join(binDir, `${prompt}.go`), '')
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await delay(10)
  expect(predicate()).toBe(true)
}

function fakeContext(
  directory: string,
  options: {
    synthetic?: (call: SyntheticCall) => Promise<unknown>
    transformError?: Error
    reloadError?: Error
  } = {},
) {
  const added: AddedTool[] = []
  const synthetic: SyntheticCall[] = []
  let disposed = 0
  const context = {
    location: { directory },
    session: {
      synthetic: async (call: SyntheticCall) => {
        synthetic.push(call)
        return options.synthetic?.(call)
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        if (options.transformError) throw options.transformError
        callback({ add: (tool: AddedTool) => added.push(tool) })
        return {
          dispose: async () => {
            disposed += 1
          },
        }
      },
      reload: async () => {
        if (options.reloadError) throw options.reloadError
      },
      list: async () => added.map((tool) => ({ ...tool, id: tool.name })),
    },
  }
  return {
    context: context as unknown as Plugin.Context,
    added,
    synthetic,
    disposed: () => disposed,
  }
}

function toolContext(sessionID: string) {
  return {
    sessionID,
    agent: 'build',
    messageID: 'msg-1',
    id: 'call-1',
    signal: new AbortController().signal,
    progress: async () => {},
  }
}

async function activate(fake: ReturnType<typeof fakeContext>) {
  const cleanup = await setupV2(fake.context)
  if (cleanup) cleanups.push(cleanup)
  return cleanup
}

function tool(fake: ReturnType<typeof fakeContext>, name: string): AddedTool {
  const found = fake.added.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} not registered`)
  return found
}

async function delegate(
  fake: ReturnType<typeof fakeContext>,
  sessionID: string,
  prompt: string,
): Promise<string> {
  const result = await tool(fake, 'copilot_delegate').execute(
    { prompt },
    toolContext(sessionID),
  )
  return (JSON.parse(result.content) as { task_id: string }).task_id
}

// The V2 server keys its port file by its own pid, never by
// `OPENCODE_SESSION_ID`: the V2 TUI is a separate process and reads the pid
// from `client.server.info()`.
function portFilePath(): string {
  return join(
    process.env.XDG_CACHE_HOME ?? '',
    'opencode',
    'copilot-delegate',
    String(process.pid),
    'server-port.json',
  )
}

function portFile(): { token: string } {
  const path = portFilePath()
  return PortFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

describe('V2 setup', () => {
  it('the default export carries the V2 setup entry', () => {
    expect(plugin.setup).toBe(setupV2)
  })

  it('publishes the RPC port file under the server pid, ignoring OPENCODE_SESSION_ID', async () => {
    const fake = fakeContext(tempDir('host-v2-ws-'))
    await activate(fake)

    expect(process.env.OPENCODE_SESSION_ID).toBe('host-v2-session')
    expect(existsSync(portFilePath())).toBe(true)
    expect(
      existsSync(
        join(
          process.env.XDG_CACHE_HOME ?? '',
          'opencode',
          'copilot-delegate',
          'host-v2-session',
        ),
      ),
    ).toBe(false)
  })

  it('registers exactly the four tools, with zod inputs equivalent to the V1 args', async () => {
    const directory = tempDir('host-v2-ws-')
    const fake = fakeContext(directory)
    await activate(fake)

    expect(fake.added.map((t) => t.name).sort()).toEqual(TOOL_NAMES)

    // V1 serializes each arg through the normalize patch; V2 converts the
    // whole input through Standard Schema, exactly as the host does
    // (core/src/tool/runtime.ts `standardJsonSchema`). A conversion failure
    // there would make V2 skip the tool silently. Both must agree on names,
    // types, descriptions, and required fields.
    const v1 = buildTools({
      client: {
        session: { prompt: async () => {} },
        app: { log: async () => {} },
      },
      directory,
      pidFilePath: '/unused',
      normalizeArgs: true,
    })
    for (const added of fake.added) {
      const v1Tool = v1[added.name as keyof typeof v1]
      expect(added.description).toBe(v1Tool.description)

      const standard = added.input['~standard'] as unknown as {
        jsonSchema: {
          input: (o: { target: string }) => Record<string, unknown>
        }
      }
      const v2Schema = standard.jsonSchema.input({ target: 'draft-2020-12' })
      const args = v1Tool.args as Record<string, z.ZodType>
      const v1Properties = Object.fromEntries(
        Object.entries(args).map(([key, schema]) => [
          key,
          (
            schema as unknown as { _zod: { toJSONSchema: () => unknown } }
          )._zod.toJSONSchema(),
        ]),
      )
      expect(v2Schema.properties).toEqual(v1Properties)
      const required = Object.entries(args)
        .filter(([, schema]) => !schema.safeParse(undefined).success)
        .map(([key]) => key)
        .sort()
      expect(
        ((v2Schema.required as string[] | undefined) ?? []).sort(),
      ).toEqual(required)
    }
  })

  it('execute returns { content } with the same envelope text V1 returns', async () => {
    const directory = tempDir('host-v2-ws-')
    const fake = fakeContext(directory)
    await activate(fake)

    const v2 = await tool(fake, 'copilot_output').execute(
      { task_id: 'cpl_missing' },
      toolContext('s1'),
    )
    const v1 = buildTools({
      client: {
        session: { prompt: async () => {} },
        app: { log: async () => {} },
      },
      directory,
      pidFilePath: '/unused',
      normalizeArgs: true,
    }).copilot_output
    const v1Result = await v1.execute(
      { task_id: 'cpl_missing', block: false, timeout_ms: 30000 } as never,
      {} as never,
    )

    expect(v2).toEqual({ content: v1Result as string })
  })

  it('returns without registering on a V1-style reduced bridge', async () => {
    const reduced = [
      {},
      { location: { directory: '/x' } },
      { location: { directory: '/x' }, session: {} },
    ]
    for (const context of reduced) {
      await expect(
        setupV2(context as unknown as Plugin.Context),
      ).resolves.toBeUndefined()
    }
    // No process resources started: no RPC port file was written
    expect(
      existsSync(
        join(process.env.XDG_CACHE_HOME ?? '', 'opencode', 'copilot-delegate'),
      ),
    ).toBe(false)
  })
})

describe('V2 notifications', () => {
  it('maps modes to session.synthetic delivery', () => {
    expect(syntheticDelivery('silent')).toEqual({ resume: false })
    expect(syntheticDelivery('final')).toEqual({ delivery: 'queue' })
    expect(syntheticDelivery('urgent')).toEqual({ delivery: 'steer' })
  })

  it('failure steers, a completion with others running is silent, the last queues', async () => {
    const fake = fakeContext(tempDir('host-v2-ws-'))
    await activate(fake)

    // Given three tasks in flight for one parent session
    const a = await delegate(fake, 'parent', 'fail-a')
    const b = await delegate(fake, 'parent', 'ok-b')
    const c = await delegate(fake, 'parent', 'ok-c')

    // When A fails, then B completes, then C completes last
    release('fail-a')
    await waitFor(() => fake.synthetic.length === 1)
    release('ok-b')
    await waitFor(() => fake.synthetic.length === 2)
    release('ok-c')
    await waitFor(() => fake.synthetic.length === 3)

    // Then each injection names its own task, in the session's own object
    const [first, second, third] = fake.synthetic
    expect(first).toMatchObject({ sessionID: 'parent', delivery: 'steer' })
    expect(String(first?.text)).toContain(a)
    expect(second).toMatchObject({ sessionID: 'parent', resume: false })
    expect(second).not.toHaveProperty('delivery')
    expect(String(second?.text)).toContain(b)
    expect(third).toMatchObject({ sessionID: 'parent', delivery: 'queue' })
    expect(String(third?.text)).toContain(c)
  })

  it('a sink failure is logged and swallowed; the tool result is unaffected', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = fakeContext(tempDir('host-v2-ws-'), {
        synthetic: async () => {
          throw new Error('inbox unavailable')
        },
      })
      await activate(fake)

      const taskId = await delegate(fake, 'parent', 'ok-x')
      expect(taskId).toStartWith('cpl_')
      release('ok-x')
      await waitFor(() =>
        stderr.mock.calls.some((args) =>
          String(args[0]).includes(
            `Failed to inject notification for ${taskId}`,
          ),
        ),
      )
    } finally {
      stderr.mockRestore()
    }
  })
})

describe('V2 release and reactivation', () => {
  it('setup → cleanup → setup cancels the running task; its notice goes nowhere', async () => {
    const directory = tempDir('host-v2-ws-')
    const first = fakeContext(directory)
    const cleanup = await setupV2(first.context)
    const tokenBefore = portFile().token

    // Given a task still running when the activation is released
    await delegate(first, 'parent', 'hang')
    expect(getAllTasks()).toHaveLength(1)

    // When the activation cleans up
    await cleanup?.()

    // Then the task was cancelled and the registry is empty
    expect(getAllTasks()).toHaveLength(0)
    expect(first.disposed()).toBe(1)

    // When the location reactivates
    const second = fakeContext(directory)
    await activate(second)

    // Then exactly one live port file exists, with the new server's token
    expect(portFile().token).not.toBe(tokenBefore)
    // And no notice from the cancelled task reached either activation
    await delay(50)
    expect(first.synthetic).toEqual([])
    expect(second.synthetic).toEqual([])
  })

  it('two locations share one process core; it stays up until both clean up', async () => {
    const one = fakeContext(tempDir('host-v2-ws-'))
    const two = fakeContext(tempDir('host-v2-ws-'))
    const cleanupOne = await setupV2(one.context)
    const cleanupTwo = await setupV2(two.context)
    const token = portFile().token

    await cleanupOne?.()
    expect(portFile().token).toBe(token)

    await cleanupTwo?.()
    expect(() => portFile()).toThrow()
  })

  it("calling one activation's cleanup twice does not tear down a live location", async () => {
    const one = fakeContext(tempDir('host-v2-ws-'))
    const two = fakeContext(tempDir('host-v2-ws-'))
    const cleanupOne = await setupV2(one.context)
    await activate(two)
    const token = portFile().token

    // When the host (or a bug) calls the first activation's cleanup twice
    await cleanupOne?.()
    await cleanupOne?.()

    // Then the second location still holds the core: same server, same token
    expect(portFile().token).toBe(token)
  })

  it('releases the core when setup fails after acquiring it', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    const failing = spyOn(coreTools, 'buildTools').mockImplementation(() => {
      throw new Error('agent discovery exploded')
    })
    try {
      // Given a setup that throws after the core was acquired
      const broken = fakeContext(tempDir('host-v2-ws-'))
      await expect(setupV2(broken.context)).resolves.toBeUndefined()
      expect(broken.added).toEqual([])
      expect(
        stderr.mock.calls.some((args) =>
          String(args[0]).includes('tool setup failed'),
        ),
      ).toBe(true)
    } finally {
      failing.mockRestore()
      stderr.mockRestore()
    }

    // Then no reference leaked: a healthy location's cleanup is the last
    // release and tears the core down
    const healthy = fakeContext(tempDir('host-v2-ws-'))
    const cleanup = await setupV2(healthy.context)
    expect(portFile().token).toBeString()
    await cleanup?.()
    expect(() => portFile()).toThrow()
  })

  it('a failed tool.transform releases the core and fails setup', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Given a host whose tool registration throws
      const broken = fakeContext(tempDir('host-v2-ws-'), {
        transformError: new Error('registry offline'),
      })

      // Then setup rejects, so the host marks the plugin failed rather than
      // active with zero tools
      await expect(setupV2(broken.context)).rejects.toThrow('registry offline')
    } finally {
      stderr.mockRestore()
    }

    // And no reference leaked: a healthy location's cleanup tears down
    const healthy = fakeContext(tempDir('host-v2-ws-'))
    const cleanup = await setupV2(healthy.context)
    expect(portFile().token).toBeString()
    await cleanup?.()
    expect(() => portFile()).toThrow()
  })

  it('a failed registration check keeps the registered tools and the cleanup', async () => {
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = fakeContext(tempDir('host-v2-ws-'), {
        reloadError: new Error('reload unavailable'),
      })
      const cleanup = await activate(fake)

      expect(fake.added.map((t) => t.name).sort()).toEqual(TOOL_NAMES)
      expect(typeof cleanup).toBe('function')
      expect(
        stderr.mock.calls.some((args) =>
          String(args[0]).includes('tool registration check failed'),
        ),
      ).toBe(true)
    } finally {
      stderr.mockRestore()
    }
  })

  it('forwards the call signal as the V1 abort signal', async () => {
    const directory = tempDir('host-v2-ws-')
    const fake = fakeContext(directory)
    await activate(fake)
    const seen: AbortSignal[] = []
    const original = coreTools.buildTools
    const spy = spyOn(coreTools, 'buildTools').mockImplementation((options) => {
      const tools = original(options)
      const execute = tools.copilot_output.execute
      tools.copilot_output.execute = async (args, context) => {
        seen.push(context.abort)
        return execute(args, context)
      }
      return tools
    })
    try {
      const spied = fakeContext(directory)
      await activate(spied)
      const call = toolContext('s1')
      await tool(spied, 'copilot_output').execute({ task_id: 'cpl_x' }, call)
      expect(seen).toEqual([call.signal])
    } finally {
      spy.mockRestore()
    }
  })
})
