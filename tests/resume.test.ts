/**
 * Tests for the copilot_resume tool.
 *
 * Covers: catalog registration, argv assembly, UUID preflight, known-task
 * addDirs reuse, validation errors, CLI no-match stderr normalization,
 * pidFilePath orphan tracking, and non-blocking behavior for name targets.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import plugin from '../src/index'
import { _resetPluginSingleton } from '../src/runtime/plugin-singleton'
import { cleanupAll } from '../src/runtime/task-registry'
import { createResumeTool } from '../src/tools/resume'

type ToolResultObject = Record<string, unknown>

const tempPaths: string[] = []
const originalPath = process.env.PATH
const originalHome = process.env.HOME
const originalXdgCacheHome = process.env.XDG_CACHE_HOME
const originalSessionId = process.env.OPENCODE_SESSION_ID
const originalCopilotConfigDir = process.env.COPILOT_CONFIG_DIR

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000'

beforeEach(() => {
  _resetPluginSingleton()

  const homeDir = mkdtempSync(join(tmpdir(), 'resume-test-home-'))
  const xdgCacheHome = mkdtempSync(join(tmpdir(), 'resume-test-cache-'))
  tempPaths.push(homeDir, xdgCacheHome)
  process.env.HOME = homeDir
  process.env.XDG_CACHE_HOME = xdgCacheHome
  process.env.OPENCODE_SESSION_ID = 'resume-test-session'
  delete process.env.COPILOT_CONFIG_DIR
})

afterEach(async () => {
  process.emit('beforeExit', 0)
  await delay(0)
  await cleanupAll()

  process.env.PATH = originalPath
  process.env.HOME = originalHome
  process.env.XDG_CACHE_HOME = originalXdgCacheHome
  process.env.OPENCODE_SESSION_ID = originalSessionId
  if (originalCopilotConfigDir === undefined) {
    delete process.env.COPILOT_CONFIG_DIR
  } else {
    process.env.COPILOT_CONFIG_DIR = originalCopilotConfigDir
  }

  for (const p of tempPaths.splice(0)) {
    rmSync(p, { force: true, recursive: true })
  }
})

function makeMockClient(): PluginInput['client'] {
  return {
    session: {
      prompt: async () => {},
    },
    tui: {
      showToast: () => {},
    },
    app: {
      log: async () => {},
    },
  } as unknown as PluginInput['client']
}

function makePluginInput(directory: string): PluginInput {
  return {
    client: makeMockClient(),
    project: {
      id: 'project-resume',
      name: 'project-resume',
      root: directory,
      worktree: directory,
      time: { created: Date.now(), updated: Date.now() },
    } as unknown as PluginInput['project'],
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:3000'),
    $: {} as PluginInput['$'],
  }
}

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: 'session-resume',
    messageID: 'message-resume',
    agent: 'default',
    directory: process.cwd(),
    worktree: process.cwd(),
    abort: new AbortController().signal,
    metadata: () => {},
    ask: (() => {
      throw new Error('ask should not be called in resume tests')
    }) as ToolContext['ask'],
    ...overrides,
  }
}

function expectObject(value: unknown): ToolResultObject {
  expect(typeof value).toBe('string')
  return JSON.parse(value as string) as ToolResultObject
}

function makeFakeResumeBin(configDir?: string): {
  binDir: string
  configDir: string
} {
  const binDir = mkdtempSync(join(tmpdir(), 'resume-test-bin-'))
  const resolvedConfigDir =
    configDir ?? mkdtempSync(join(tmpdir(), 'resume-test-config-'))
  tempPaths.push(binDir, resolvedConfigDir)

  const sessionStateDir = join(resolvedConfigDir, 'session-state', VALID_UUID)
  mkdirSync(sessionStateDir, { recursive: true })
  writeFileSync(join(sessionStateDir, 'session.db'), '')

  const copilotPath = join(binDir, 'copilot')
  writeFileSync(
    copilotPath,
    `#!/usr/bin/env bash
resume_id=""
add_dirs=()

while [ $# -gt 0 ]; do
  case "$1" in
    --resume=*)
      resume_id="\${1#--resume=}"
      ;;
    --add-dir)
      shift
      add_dirs+=("$1")
      ;;
    --add-dir=*)
      add_dirs+=("\${1#--add-dir=}")
      ;;
  esac
  shift
done

case "$resume_id" in
  "no-match-name")
    echo "Error: No session, task, or name matched 'no-match-name'" >&2
    exit 1
    ;;
  "${VALID_UUID}")
    if [ "\${#add_dirs[@]}" -gt 0 ]; then
      printf '%s\\n' '{"type":"add-dirs","count":"'"\${#add_dirs[@]}"'"}'
    fi
    printf '%s\\n' '{"type":"assistant.message","data":{"messageId":"msg-resume","content":"resumed","toolRequests":[]}}'
    printf '%s\\n' '{"type":"result","sessionId":"${VALID_UUID}","exitCode":0,"usage":{}}'
    exit 0
    ;;
  *)
    printf '%s\\n' '{"type":"assistant.message","data":{"messageId":"msg-default","content":"default","toolRequests":[]}}'
    printf '%s\\n' '{"type":"result","sessionId":"session-default","exitCode":0,"usage":{}}'
    exit 0
    ;;
esac
`,
  )
  chmodSync(copilotPath, 0o755)

  return { binDir, configDir: resolvedConfigDir }
}

function makeLongRunningResumeBin(sleepMs: number): { binDir: string } {
  const binDir = mkdtempSync(join(tmpdir(), 'resume-test-slow-bin-'))
  tempPaths.push(binDir)

  const copilotPath = join(binDir, 'copilot')
  const sleepSecs = (sleepMs / 1000).toFixed(3)
  writeFileSync(
    copilotPath,
    `#!/usr/bin/env bash
sleep ${sleepSecs}
printf '%s\\n' '{"type":"assistant.message","data":{"messageId":"msg-slow","content":"slow","toolRequests":[]}}'
printf '%s\\n' '{"type":"result","sessionId":"session-slow","exitCode":0,"usage":{}}'
exit 0
`,
  )
  chmodSync(copilotPath, 0o755)

  return { binDir }
}

describe('copilot_resume tool', () => {
  describe('catalog registration', () => {
    it('registers copilot_resume as the 4th tool (catalog grows 3 → 4)', async () => {
      const input = makePluginInput(process.cwd())
      const result = await plugin(input)

      expect(Object.keys(result.tool ?? {}).sort()).toEqual([
        'copilot_cancel',
        'copilot_delegate',
        'copilot_output',
        'copilot_resume',
      ])
    })

    it('copilot_resume args carry normalizeToolArgSchemas overrides', async () => {
      const input = makePluginInput(process.cwd())
      const result = await plugin(input)
      const tools = result.tool as NonNullable<typeof result.tool>

      const resumeArgs = tools.copilot_resume.args as Record<string, unknown>
      const targetIdSchema = resumeArgs.targetId
      const override = (
        targetIdSchema as { _zod: { toJSONSchema?: () => unknown } }
      )._zod.toJSONSchema

      expect(typeof override).toBe('function')
      const emitted = override?.() as Record<string, unknown>
      expect(typeof emitted.description).toBe('string')
      expect((emitted.description as string).length).toBeGreaterThan(10)
    })
  })

  describe('UUID target with local session present', () => {
    it('spawns copilot --resume=<uuid> and returns a cpl_ task_id', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-uuid-happy-'))
      tempPaths.push(cwd)

      const { binDir, configDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = configDir

      const client = makeMockClient()
      const tool = createResumeTool({
        client,
        directory: cwd,
      })

      const raw = await tool.execute(
        { targetId: VALID_UUID },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
      expect(output.error).toBeUndefined()
    })

    it('created task has origin: resume', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-origin-'))
      tempPaths.push(cwd)

      const { binDir, configDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = configDir

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: VALID_UUID },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const { task_id: taskId } = expectObject(raw)
      expect(typeof taskId).toBe('string')

      const { getTask } = await import('../src/runtime/task-registry')
      const task = getTask(taskId as string)
      expect(task?.origin).toBe('resume')
    })
  })

  describe('UUID target with no local session', () => {
    it('returns structured error without spawning when session.db is absent', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-no-session-'))
      const emptyConfigDir = mkdtempSync(join(tmpdir(), 'resume-empty-config-'))
      tempPaths.push(cwd, emptyConfigDir)

      const binDir = mkdtempSync(join(tmpdir(), 'resume-no-session-bin-'))
      tempPaths.push(binDir)
      const copilotPath = join(binDir, 'copilot')
      writeFileSync(
        copilotPath,
        `#!/usr/bin/env bash
echo "SHOULD NOT SPAWN" >&2
exit 1
`,
      )
      chmodSync(copilotPath, 0o755)

      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = emptyConfigDir

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: VALID_UUID },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBe(`No local session found for UUID ${VALID_UUID}`)
      expect(output.task_id).toBeUndefined()
    })
  })

  describe('known plugin task target reuses captured addDirs', () => {
    it('reuses addDirs from a known task when caller omits addDirs', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-known-task-'))
      tempPaths.push(cwd)

      const { binDir, configDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = configDir

      const { createTask } = await import('../src/runtime/task-registry')
      const { spawnCopilot } = await import('../src/runtime/subprocess')

      const fakeSpawn = spawnCopilot(
        [
          '-p',
          'Return JSONL',
          '--output-format',
          'json',
          '-s',
          '--allow-all-tools',
          '--no-ask-user',
        ],
        { cwd },
      )
      const knownTask = createTask({
        ...fakeSpawn,
        parentSessionID: 'session-known',
        startedAt: Date.now(),
        args: ['-p', 'Return JSONL'],
        cwd,
        origin: 'spawn',
        addDirs: [cwd],
      })
      knownTask.copilotSessionId = VALID_UUID

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: VALID_UUID },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
      expect(output.error).toBeUndefined()

      const { getTask } = await import('../src/runtime/task-registry')
      const resumeTask = getTask(output.task_id as string)
      expect(resumeTask?.args).toBeDefined()
      const args = resumeTask?.args ?? []
      const addDirIdx = args.indexOf('--add-dir')
      expect(addDirIdx).toBeGreaterThanOrEqual(0)
      expect(args[addDirIdx + 1]).toBe(cwd)
    })
  })

  describe('invalid target ID', () => {
    it('returns validation error for path-traversal-shaped target', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-invalid-target-'))
      tempPaths.push(cwd)

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: '../../etc/passwd' },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBeDefined()
      expect(typeof output.error).toBe('string')
      expect(output.task_id).toBeUndefined()
    })

    it('returns validation error for overlong target ID', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-overlong-'))
      tempPaths.push(cwd)

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: 'a'.repeat(200) },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBeDefined()
      expect(output.task_id).toBeUndefined()
    })
  })

  describe('invalid addDirs and cwd validation', () => {
    it('returns error for argv-injection-shaped addDirs without spawning', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-bad-adddir-'))
      tempPaths.push(cwd)

      const { binDir, configDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = configDir

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        {
          targetId: VALID_UUID,
          addDirs: ['--allow-tool=shell(*)'],
        },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBeDefined()
      expect(typeof output.error).toBe('string')
      expect(output.task_id).toBeUndefined()
    })

    it('returns error for cwd outside allowed roots without spawning', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-bad-cwd-'))
      tempPaths.push(cwd)

      const { binDir, configDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`
      process.env.COPILOT_CONFIG_DIR = configDir

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        {
          targetId: VALID_UUID,
          cwd: '/etc',
        },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBeDefined()
      expect(output.task_id).toBeUndefined()
    })
  })

  describe('CLI no-match stderr normalization', () => {
    it('normalizes no-match stderr to Session not found error', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-no-match-'))
      tempPaths.push(cwd)

      const { binDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: 'no-match-name' },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.error).toBe("Session not found: 'no-match-name'")
      expect(output.task_id).toBeUndefined()
    })
  })

  describe('name target (non-UUID)', () => {
    it('spawns without UUID preflight for a valid name target', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-name-target-'))
      tempPaths.push(cwd)

      const { binDir } = makeFakeResumeBin()
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const raw = await tool.execute(
        { targetId: 'my-session-name' },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const output = expectObject(raw)
      expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
      expect(output.error).toBeUndefined()
    })

    it('returns task_id promptly for a long-running name target without blocking', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-name-slow-'))
      tempPaths.push(cwd)

      const { binDir } = makeLongRunningResumeBin(1000)
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd })

      const before = Date.now()
      const raw = await tool.execute(
        { targetId: 'long-running-session' },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )
      const elapsed = Date.now() - before

      const output = expectObject(raw)
      expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
      expect(output.error).toBeUndefined()
      expect(elapsed).toBeLessThan(900)
    })
  })

  describe('pidFilePath orphan tracking', () => {
    it('passes pidFilePath from tool options into the spawned task and writes the pid file', async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'resume-pid-'))
      tempPaths.push(cwd)

      const { binDir } = makeLongRunningResumeBin(1000)
      process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`

      const pidFilePath = join(cwd, 'orphan.pid')
      const client = makeMockClient()
      const tool = createResumeTool({ client, directory: cwd, pidFilePath })

      const raw = await tool.execute(
        { targetId: 'long-running-session' },
        makeToolContext({ directory: cwd, worktree: cwd }),
      )

      const { task_id: taskId } = expectObject(raw)
      expect(typeof taskId).toBe('string')

      const { getTask } = await import('../src/runtime/task-registry')
      const task = getTask(taskId as string)
      expect(task?.pid).toBeGreaterThan(0)

      const deadline = Date.now() + 1000
      while (!existsSync(pidFilePath) && Date.now() < deadline) {
        await delay(20)
      }

      expect(existsSync(pidFilePath)).toBe(true)
      const pidFileContent = readFileSync(pidFilePath, 'utf8').trim()
      expect(
        pidFileContent
          .split('\n')
          .some((line) => line.startsWith(`${task?.pid}\t`)),
      ).toBe(true)
    })
  })
})

describe('plugin tool catalog with copilot_resume', () => {
  it('lists exactly 4 tools after resume registration', async () => {
    const input = makePluginInput(process.cwd())
    const result = await plugin(input)

    const toolNames = Object.keys(result.tool ?? {}).sort()
    expect(toolNames).toEqual([
      'copilot_cancel',
      'copilot_delegate',
      'copilot_output',
      'copilot_resume',
    ])
  })

  it('schema-walk covers copilot_resume targetId and addDirs args', async () => {
    const input = makePluginInput(process.cwd())
    const result = await plugin(input)
    const tools = result.tool as NonNullable<typeof result.tool>

    const cases: Array<{ tool: keyof typeof tools; arg: string }> = [
      { tool: 'copilot_resume', arg: 'targetId' },
      { tool: 'copilot_resume', arg: 'addDirs' },
    ]

    for (const { tool: toolId, arg } of cases) {
      const schema = (tools[toolId].args as Record<string, unknown>)[arg]
      const override = (schema as { _zod: { toJSONSchema?: () => unknown } })
        ._zod.toJSONSchema
      expect(typeof override).toBe('function')

      const emitted = override?.() as Record<string, unknown>
      expect(typeof emitted.description).toBe('string')
      expect((emitted.description as string).length).toBeGreaterThan(5)
    }
  })
})
