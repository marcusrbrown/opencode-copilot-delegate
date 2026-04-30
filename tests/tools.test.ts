import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import plugin from '../src/index'
import { _resetPluginSingleton } from '../src/runtime/plugin-singleton'
import { cleanupAll } from '../src/runtime/task-registry'
import { createDelegateTool } from '../src/tools/delegate'

type PromptCall = {
  sessionId: string
  noReply: boolean
  text: string
}

type ToastCall = {
  message: string
  variant: string
}

type MockClient = PluginInput['client'] & {
  promptCalls: PromptCall[]
  toastCalls: ToastCall[]
}

type ToolResultObject = Record<string, unknown>

const tempPaths: string[] = []
const originalPath = process.env.PATH

beforeEach(() => {
  // Each test loads `plugin(input)` and asserts on the returned tool dispatch.
  // The singleton would short-circuit subsequent invocations and reuse the
  // first test's MockClient/PATH, breaking per-test isolation. Reset between
  // tests so each `await plugin(input)` runs init for real.
  _resetPluginSingleton()
})

afterEach(async () => {
  await cleanupAll()

  process.env.PATH = originalPath

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

function makeFakeCopilotBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'copilot-tool-bin-'))
  const copilotPath = join(binDir, 'copilot')

  writeFileSync(
    copilotPath,
    `#!/usr/bin/env bash
prompt=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    shift
    prompt="$1"
    break
  fi
  shift
done

case "$prompt" in
  "Return JSONL")
    printf '%s\n' '{"type":"assistant.message","data":{"messageId":"msg-1","content":"done","toolRequests":[]}}'
    printf '%s\n' '{"type":"result","sessionId":"session-1","exitCode":0,"usage":{}}'
    exit 0
    ;;
  "sleep then return")
    sleep 2
    printf '%s\n' '{"type":"assistant.message","data":{"messageId":"msg-2","content":"slow","toolRequests":[]}}'
    printf '%s\n' '{"type":"result","sessionId":"session-2","exitCode":0,"usage":{}}'
    exit 0
    ;;
  "almost timeout")
    sleep 0.8
    printf '%s\n' '{"type":"assistant.message","data":{"messageId":"msg-3","content":"fast enough","toolRequests":[]}}'
    printf '%s\n' '{"type":"result","sessionId":"session-3","exitCode":0,"usage":{}}'
    exit 0
    ;;
  *)
    printf '%s\n' '{"type":"assistant.message","data":{"messageId":"msg-default","content":"default","toolRequests":[]}}'
    printf '%s\n' '{"type":"result","sessionId":"session-default","exitCode":0,"usage":{}}'
    exit 0
    ;;
esac
`,
  )
  chmodSync(copilotPath, 0o755)

  return binDir
}

function makeMockClient(): MockClient {
  const promptCalls: PromptCall[] = []
  const toastCalls: ToastCall[] = []

  return {
    promptCalls,
    toastCalls,
    session: {
      prompt: async (opts: {
        path: { id: string }
        body: {
          noReply: boolean
          parts: Array<{ type: 'text'; text: string; synthetic: boolean }>
        }
      }) => {
        promptCalls.push({
          sessionId: opts.path.id,
          noReply: opts.body.noReply,
          text: opts.body.parts[0]?.text ?? '',
        })
      },
    },
    tui: {
      showToast: (opts: {
        body: {
          message: string
          variant: 'info' | 'success' | 'warning' | 'error'
        }
      }) => {
        toastCalls.push(opts.body)
      },
    },
    app: {
      log: () => {},
    },
  } as unknown as MockClient
}

function makePluginInput(directory: string): PluginInput {
  return {
    client: makeMockClient(),
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

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: 'session-tools',
    messageID: 'message-tools',
    agent: 'default',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: (() => {
      throw new Error('ask should not be called in tool tests')
    }) as ToolContext['ask'],
    ...overrides,
  }
}

function expectObject(value: unknown): ToolResultObject {
  expect(typeof value).toBe('string')

  return JSON.parse(value as string) as ToolResultObject
}

function requireTools(result: Awaited<ReturnType<typeof plugin>>) {
  expect(result.tool).toBeDefined()
  return result.tool as NonNullable<typeof result.tool>
}

describe('plugin tools', () => {
  it('registers the three plugin tools', async () => {
    // Given a plugin input
    const input = makePluginInput(process.cwd())

    // When the plugin is loaded
    const result = await plugin(input)

    // Then all tool names are registered
    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
    ])
  })

  it('builds a non-trivial delegate description', async () => {
    // Given a plugin input
    const input = makePluginInput(process.cwd())

    // When the plugin is loaded
    const result = await plugin(input)

    // Then the delegate description includes dynamic agent text
    expect(result.tool?.copilot_delegate.description.length).toBeGreaterThan(50)
  })

  it('wires normalizeToolArgSchemas on registered tool args', async () => {
    // Given a plugin input
    const input = makePluginInput(process.cwd())

    // When the plugin is loaded
    const result = await plugin(input)
    const tools = requireTools(result)

    // Then each registered tool's args carry a _zod.toJSONSchema override that
    // surfaces .describe() text — guards against a future tool registration
    // path forgetting to call normalizeToolArgSchemas(...).
    const cases: Array<{ tool: keyof typeof tools; arg: string }> = [
      { tool: 'copilot_delegate', arg: 'prompt' },
      { tool: 'copilot_delegate', arg: 'agent' },
      { tool: 'copilot_output', arg: 'task_id' },
      { tool: 'copilot_output', arg: 'block' },
      { tool: 'copilot_cancel', arg: 'task_id' },
    ]

    for (const { tool: toolId, arg } of cases) {
      const schema = (tools[toolId].args as Record<string, unknown>)[arg]
      const override = (schema as { _zod: { toJSONSchema?: () => unknown } })
        ._zod.toJSONSchema
      expect(typeof override).toBe('function')

      const emitted = override?.() as Record<string, unknown>
      expect(typeof emitted.description).toBe('string')
      expect((emitted.description as string).length).toBeGreaterThan(10)
    }
  })

  it('delegates a task and returns a cpl_ task id', async () => {
    // Given a fake copilot binary that emits valid JSONL and exits successfully
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-cwd-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const input = makePluginInput(cwd)
    const result = await plugin(input)
    const tools = requireTools(result)

    // When the delegate tool executes
    const raw = await tools.copilot_delegate.execute(
      {
        prompt: 'Return JSONL',
      },
      makeToolContext({ directory: cwd, worktree: cwd }),
    )

    // Then it returns a generated task id
    const output = expectObject(raw)
    expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
  })

  it('returns structured unknown status for missing output tasks', async () => {
    // Given the loaded plugin tools
    const result = await plugin(makePluginInput(process.cwd()))
    const tools = requireTools(result)

    // When output is requested for a nonexistent task
    const raw = await tools.copilot_output.execute(
      { task_id: 'cpl_nonexistent' },
      makeToolContext(),
    )

    // Then it returns an unknown status envelope instead of throwing
    const output = expectObject(raw)
    expect(output).toMatchObject({
      task_id: 'cpl_nonexistent',
      status: 'unknown',
    })
  })

  it('returns structured errors for malformed task ids', async () => {
    // Given the loaded plugin tools
    const result = await plugin(makePluginInput(process.cwd()))
    const tools = requireTools(result)

    // When output is requested with malformed task ids
    const emptyRaw = await tools.copilot_output.execute(
      { task_id: '' },
      makeToolContext(),
    )
    const badRaw = await tools.copilot_output.execute(
      { task_id: 'bad_id' },
      makeToolContext(),
    )

    // Then each call returns a structured error envelope
    expect(expectObject(emptyRaw)).toMatchObject({
      task_id: '',
      status: 'unknown',
      error: 'Invalid task_id format',
    })
    expect(expectObject(badRaw)).toMatchObject({
      task_id: 'bad_id',
      status: 'unknown',
      error: 'Invalid task_id format',
    })
  })

  it('returns a non-running result when cancelling an unknown task', async () => {
    // Given the loaded plugin tools
    const result = await plugin(makePluginInput(process.cwd()))
    const tools = requireTools(result)

    // When cancel is requested for an unknown task
    const raw = await tools.copilot_cancel.execute(
      { task_id: 'cpl_nonexistent' },
      makeToolContext(),
    )

    // Then the tool returns a structured non-running response
    expect(expectObject(raw)).toMatchObject({
      cancelled: false,
      was_running: false,
    })
  })

  it('times out in blocking mode when the subprocess takes too long', async () => {
    // Given a delegated task that outlives the requested block timeout
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-timeout-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const delegateRaw = await tools.copilot_delegate.execute(
      {
        prompt: 'sleep then return',
      },
      makeToolContext({ directory: cwd, worktree: cwd }),
    )
    const taskId = String(expectObject(delegateRaw).task_id)

    // When blocking output waits with a short timeout
    const raw = await tools.copilot_output.execute(
      { task_id: taskId, block: true, timeout_ms: 500 },
      makeToolContext(),
    )

    // Then the returned envelope is marked timed out
    expect(expectObject(raw)).toMatchObject({
      task_id: taskId,
      timed_out: true,
    })
  })

  it('does not mark output as timed out when completion wins the race', async () => {
    // Given a delegated task that completes just before the timeout
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-near-timeout-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const delegateRaw = await tools.copilot_delegate.execute(
      {
        prompt: 'almost timeout',
      },
      makeToolContext({ directory: cwd, worktree: cwd }),
    )
    const taskId = String(expectObject(delegateRaw).task_id)

    // When blocking output waits slightly longer than task completion
    const raw = await tools.copilot_output.execute(
      { task_id: taskId, block: true, timeout_ms: 1200 },
      makeToolContext(),
    )

    // Then the completed envelope wins and is not timed out
    const output = expectObject(raw)
    expect(output.task_id).toBe(taskId)
    expect(output.timed_out).not.toBe(true)
  })

  it('returns a structured error when copilot fails to spawn synchronously', async () => {
    // Given a delegate tool configured with an invalid cwd string
    const client = makeMockClient()
    const invalidCwd = `bad\u0000cwd`
    const delegateTool = createDelegateTool({
      client,
      description: 'delegate test',
      directory: invalidCwd,
      // pidFilePath is currently optional; pass an explicit fixture so a
      // future required-parameter refactor does not break this test silently.
      pidFilePath: join(tmpdir(), 'spawn-error-fixture.pids'),
    })

    // When delegation is attempted
    const raw = await delegateTool.execute(
      { prompt: 'Return JSONL' },
      makeToolContext(),
    )

    // Then it returns a structured spawn error instead of throwing
    expect(expectObject(raw)).toMatchObject({
      error: expect.stringContaining('Failed to spawn copilot:'),
    })
  })

  it('cancels a running task and reports cancelled status', async () => {
    // Given a delegated task that takes a long time
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-cancel-running-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const input = makePluginInput(cwd)
    const result = await plugin(input)
    const tools = requireTools(result)
    const delegateRaw = await tools.copilot_delegate.execute(
      { prompt: 'sleep then return' },
      makeToolContext({ directory: cwd, worktree: cwd }),
    )
    const taskId = String(expectObject(delegateRaw).task_id)

    // When the running task is cancelled
    const cancelRaw = await tools.copilot_cancel.execute(
      { task_id: taskId },
      makeToolContext(),
    )

    // Then cancel reports success
    const cancelResult = expectObject(cancelRaw)
    expect(cancelResult).toMatchObject({ cancelled: true, was_running: true })

    // And subsequent output shows cancelled status
    const outputRaw = await tools.copilot_output.execute(
      { task_id: taskId, block: true, timeout_ms: 5000 },
      makeToolContext(),
    )
    const outputResult = expectObject(outputRaw)
    expect(outputResult.status).toBe('cancelled')
  })

  it('enforces the MAX_CONCURRENT delegation limit', async () => {
    // Given ten running delegated tasks
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-limit-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const ctx = makeToolContext({ directory: cwd, worktree: cwd })

    for (let index = 0; index < 10; index++) {
      const raw = await tools.copilot_delegate.execute(
        { prompt: 'sleep then return' },
        ctx,
      )
      expect(expectObject(raw).task_id).toMatch(/^cpl_[0-9a-f-]+$/)
    }

    // When an eleventh task is delegated
    const raw = await tools.copilot_delegate.execute(
      { prompt: 'sleep then return' },
      ctx,
    )

    // Then the tool rejects the request with a concurrency error
    expect(expectObject(raw)).toMatchObject({
      error:
        'Concurrent delegation limit reached (10 running). Cancel or wait for existing tasks.',
    })
  })

  it('returns a non-running result when cancelling a completed task', async () => {
    // Given a delegated task that has already completed
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-cancel-complete-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const ctx = makeToolContext({ directory: cwd, worktree: cwd })
    const delegateRaw = await tools.copilot_delegate.execute(
      { prompt: 'Return JSONL' },
      ctx,
    )
    const taskId = String(expectObject(delegateRaw).task_id)
    const outputRaw = await tools.copilot_output.execute(
      { task_id: taskId, block: true, timeout_ms: 5000 },
      ctx,
    )
    expect(expectObject(outputRaw)).toMatchObject({
      task_id: taskId,
      status: 'complete',
    })

    // When cancel is requested after completion
    const raw = await tools.copilot_cancel.execute({ task_id: taskId }, ctx)

    // Then the tool reports that nothing was running anymore
    expect(expectObject(raw)).toMatchObject({
      cancelled: false,
      was_running: false,
    })
  })

  it('delegates successfully with optional agent and model args', async () => {
    // Given a delegated task with optional agent and model arguments
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-optional-args-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const ctx = makeToolContext({ directory: cwd, worktree: cwd })

    // When the task is delegated and its output is retrieved
    const delegateRaw = await tools.copilot_delegate.execute(
      {
        prompt: 'Return JSONL',
        agent: 'test-agent',
        model: 'test-model',
      },
      ctx,
    )
    const taskId = String(expectObject(delegateRaw).task_id)
    const outputRaw = await tools.copilot_output.execute(
      { task_id: taskId, block: true, timeout_ms: 1000 },
      ctx,
    )

    // Then the task completes and preserves the optional metadata in the envelope
    expect(expectObject(delegateRaw).task_id).toMatch(/^cpl_[0-9a-f-]+$/)
    expect(expectObject(outputRaw)).toMatchObject({
      task_id: taskId,
      agent: 'test-agent',
      model: 'test-model',
    })
  })

  it('returns a running envelope for non-blocking output on a running task', async () => {
    // Given a delegated task that is still running
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-tools-running-output-'))
    const binDir = makeFakeCopilotBin()
    tempPaths.push(cwd, binDir)

    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

    const result = await plugin(makePluginInput(cwd))
    const tools = requireTools(result)
    const ctx = makeToolContext({ directory: cwd, worktree: cwd })
    const delegateRaw = await tools.copilot_delegate.execute(
      { prompt: 'sleep then return' },
      ctx,
    )
    const taskId = String(expectObject(delegateRaw).task_id)

    // When output is requested without blocking
    const raw = await tools.copilot_output.execute({ task_id: taskId }, ctx)

    // Then the current running envelope is returned immediately
    expect(expectObject(raw)).toMatchObject({
      task_id: taskId,
      status: 'running',
    })
  })
})
