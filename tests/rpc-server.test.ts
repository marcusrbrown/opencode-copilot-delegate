import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ParsedEvent } from '../src/runtime/jsonl-parser'
import {
  HealthResponseSchema,
  PortFileSchema,
  TasksCancelResponseSchema,
  TasksListResponseSchema,
} from '../src/runtime/rpc-contract'
import { startRpcServer } from '../src/runtime/rpc-server'

type FakeTask = {
  taskId: string
  status: 'running' | 'complete' | 'failed' | 'cancelled'
  agentName?: string
  modelName?: string
  startedAt: number
  endedAt?: number
  events?: ParsedEvent[]
}

type StartedTestServer = Awaited<ReturnType<typeof startRpcServer>> & {
  portFilePath: string
  closed: boolean
}

const tempPaths: string[] = []
const startedServers: StartedTestServer[] = []

afterEach(async () => {
  for (const server of startedServers.splice(0)) {
    if (!server.closed) {
      await server.close()
    }
  }

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-server-'))
  tempPaths.push(dir)
  return dir
}

function makeUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`
}

function makeAuthHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
  }
}

function makeToolUseEvent(toolCallId: string): ParsedEvent {
  return {
    type: 'tool_use',
    data: {
      toolCallId,
      toolName: 'bash',
    },
    raw: {},
  }
}

async function startTestServer(overrides?: {
  tasks?: FakeTask[]
  now?: () => number
  cancelTaskById?: (
    taskId: string,
  ) =>
    | { cancelled: boolean; error?: string }
    | Promise<{ cancelled: boolean; error?: string }>
  portFileBaseDir?: string
  sessionDiscriminator?: string
}) {
  const portFileBaseDir = overrides?.portFileBaseDir ?? makeCacheDir()
  const sessionDiscriminator = overrides?.sessionDiscriminator ?? 'session-a'
  const started = await startRpcServer({
    taskRegistry: {
      getAllTasks: () => overrides?.tasks ?? [],
    },
    cancelTaskById:
      overrides?.cancelTaskById ??
      (() => {
        return { cancelled: true }
      }),
    portFileBaseDir,
    sessionDiscriminator,
    now: overrides?.now,
  })

  const wrapped: StartedTestServer = {
    ...started,
    portFilePath: join(
      portFileBaseDir,
      sessionDiscriminator,
      'server-port.json',
    ),
    closed: false,
    close: async () => {
      if (wrapped.closed) {
        return
      }

      wrapped.closed = true
      await started.close()
    },
  }

  startedServers.push(wrapped)
  return wrapped
}

async function postJson(port: number, path: string, token: string, body = {}) {
  return fetch(makeUrl(port, path), {
    method: 'POST',
    headers: {
      ...makeAuthHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('rpc server', () => {
  it('serves health without auth', async () => {
    const server = await startTestServer()

    const response = await fetch(makeUrl(server.port, '/health'))

    expect(response.status).toBe(200)
    expect(HealthResponseSchema.parse(await response.json())).toEqual({
      ok: true,
      version: expect.any(String),
    })
  })

  it('requires auth for task listing', async () => {
    const server = await startTestServer()

    const response = await fetch(makeUrl(server.port, '/tasks/list'), {
      method: 'POST',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'unauthorized' })
  })

  it('returns a validated running task list and filters terminal tasks', async () => {
    const startedAt = 1_000
    const server = await startTestServer({
      now: () => 2_500,
      tasks: [
        {
          taskId: 'cpl_running',
          status: 'running',
          agentName: 'delegate-agent',
          modelName: 'gpt-5',
          startedAt,
          events: [makeToolUseEvent('tool-1'), makeToolUseEvent('tool-2')],
        },
        {
          taskId: 'cpl_complete',
          status: 'complete',
          startedAt,
          endedAt: 2_000,
        },
      ],
    })

    const response = await postJson(server.port, '/tasks/list', server.token)
    const body = TasksListResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    expect(body).toEqual({
      tasks: [
        {
          taskId: 'cpl_running',
          status: 'running',
          agent: 'delegate-agent',
          model: 'gpt-5',
          elapsedMs: 1_500,
          toolCallCount: 2,
          startedAt,
        },
      ],
    })
  })

  it('cancels a task through the injected cancel function idempotently', async () => {
    const cancelledTaskIds: string[] = []
    const server = await startTestServer({
      cancelTaskById: (taskId) => {
        cancelledTaskIds.push(taskId)
        return { cancelled: true }
      },
    })

    const first = await postJson(server.port, '/tasks/cancel', server.token, {
      taskId: 'cpl_task-1',
    })
    const second = await postJson(server.port, '/tasks/cancel', server.token, {
      taskId: 'cpl_task-1',
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(TasksCancelResponseSchema.parse(await first.json())).toEqual({
      cancelled: true,
    })
    expect(TasksCancelResponseSchema.parse(await second.json())).toEqual({
      cancelled: true,
    })
    expect(cancelledTaskIds).toEqual(['cpl_task-1', 'cpl_task-1'])
  })

  it('returns 404 when canceling an unknown task', async () => {
    const server = await startTestServer({
      cancelTaskById: () => ({ cancelled: false, error: 'no such task' }),
    })

    const response = await postJson(
      server.port,
      '/tasks/cancel',
      server.token,
      {
        taskId: 'cpl_unknown',
      },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      cancelled: false,
      error: 'no such task',
    })
  })

  it('rejects malformed JSON and invalid cancel request bodies', async () => {
    const server = await startTestServer()

    const malformed = await fetch(makeUrl(server.port, '/tasks/cancel'), {
      method: 'POST',
      headers: {
        ...makeAuthHeaders(server.token),
        'Content-Type': 'application/json',
      },
      body: '{',
    })
    const invalid = await postJson(server.port, '/tasks/cancel', server.token, {
      taskId: 123,
    })

    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: expect.any(String) })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: expect.any(String) })
  })

  it('returns 413 for oversized JSON bodies', async () => {
    const server = await startTestServer()

    const response = await fetch(makeUrl(server.port, '/tasks/cancel'), {
      method: 'POST',
      headers: {
        ...makeAuthHeaders(server.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taskId: 'cpl_task', padding: 'x'.repeat(70_000) }),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request body too large' })
  })

  it('short-circuits malformed auth headers with 401 responses', async () => {
    const server = await startTestServer()
    const cases = [
      undefined,
      'Basic abc',
      'Bearer',
      'Bearer short',
      `Bearer ${'x'.repeat(server.token.length)}`,
    ]

    for (const authorization of cases) {
      const headers: Record<string, string> = {}
      if (authorization) {
        headers.Authorization = authorization
      }

      const response = await fetch(makeUrl(server.port, '/tasks/cancel'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskId: 'cpl_task-1' }),
      })

      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'unauthorized' })
    }
  })

  it('writes the port file with the expected path, content, and permissions', async () => {
    const server = await startTestServer({ sessionDiscriminator: 'session-1' })

    expect(server.port).toBeGreaterThan(0)
    expect(server.token.length).toBeGreaterThan(0)
    expect(server.portFilePath.endsWith('/session-1/server-port.json')).toBe(
      true,
    )
    expect(existsSync(server.portFilePath)).toBe(true)

    const portFileStat = statSync(server.portFilePath)
    const sessionDirStat = statSync(join(server.portFilePath, '..'))
    const portFile = PortFileSchema.parse(
      JSON.parse(readFileSync(server.portFilePath, 'utf8')),
    )

    expect(sessionDirStat.mode & 0o777).toBe(0o700)
    expect(portFileStat.mode & 0o777).toBe(0o600)
    expect(portFile).toEqual({
      port: server.port,
      pid: process.pid,
      token: server.token,
    })
  })

  it('supports concurrent servers with distinct discriminators and tokens', async () => {
    const portFileBaseDir = makeCacheDir()
    const first = await startTestServer({
      portFileBaseDir,
      sessionDiscriminator: 'session-one',
    })
    const second = await startTestServer({
      portFileBaseDir,
      sessionDiscriminator: 'session-two',
    })

    expect(first.port).not.toBe(second.port)
    expect(first.token).not.toBe(second.token)
    expect(existsSync(first.portFilePath)).toBe(true)
    expect(existsSync(second.portFilePath)).toBe(true)

    const crossToken = await postJson(first.port, '/tasks/list', second.token)
    expect(crossToken.status).toBe(401)
  })

  it('removes stale files from the discriminator directory on startup', async () => {
    const portFileBaseDir = makeCacheDir()
    const staleDir = join(portFileBaseDir, 'session-stale')
    const staleFile = join(staleDir, 'old-server-port.json')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(staleFile, '{}')

    const server = await startTestServer({
      portFileBaseDir,
      sessionDiscriminator: 'session-stale',
    })

    expect(existsSync(staleFile)).toBe(false)
    expect(existsSync(server.portFilePath)).toBe(true)
  })

  it('closes the server and removes the port file', async () => {
    const server = await startTestServer()

    expect(existsSync(server.portFilePath)).toBe(true)

    await server.close()

    expect(existsSync(server.portFilePath)).toBe(false)
    await expect(fetch(makeUrl(server.port, '/health'))).rejects.toThrow()
  })
})
