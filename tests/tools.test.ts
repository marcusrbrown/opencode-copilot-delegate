import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import plugin from '../src/index'
import { cleanupAll } from '../src/runtime/task-registry'

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
  expect(typeof value).toBe('object')
  expect(value).not.toBeNull()

  return value as ToolResultObject
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
})
