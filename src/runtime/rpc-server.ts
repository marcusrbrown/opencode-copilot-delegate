import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ZodError, ZodType } from 'zod'
import type { CancelTaskResult } from './cancel-helper'
import type { ParsedEvent } from './jsonl-parser'
import {
  HealthResponseSchema,
  PortFileSchema,
  TasksCancelRequestSchema,
  TasksCancelResponseSchema,
  type TasksListResponse,
  TasksListResponseSchema,
} from './rpc-contract'

type RpcTaskRecord = {
  taskId: string
  status: string
  agentName?: string
  modelName?: string
  startedAt: number
  endedAt?: number
  events?: ParsedEvent[]
}

type TaskRegistryLike = {
  getAllTasks(): RpcTaskRecord[]
}

export type StartRpcServerOptions = {
  taskRegistry: TaskRegistryLike
  cancelTaskById: (
    taskId: string,
  ) => CancelTaskResult | Promise<CancelTaskResult>
  portFileBaseDir?: string
  sessionDiscriminator?: string
  now?: () => number
}

export type StartedRpcServer = {
  port: number
  token: string
  close(): Promise<void>
}

const MAX_JSON_BODY_BYTES = 64 * 1024
const packageVersion = readPackageVersion()

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown }

    if (
      typeof packageJson.version === 'string' &&
      packageJson.version.length > 0
    ) {
      return packageJson.version
    }
  } catch {
    // Fall through to a safe default when the local package manifest is
    // unavailable in tests or alternate runtimes.
  }

  return '0.0.0'
}

function defaultPortFileBaseDir(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? homedir(), '.cache')

  return join(cacheHome, 'opencode', 'copilot-delegate')
}

function defaultSessionDiscriminator(): string {
  return process.env.OPENCODE_SESSION_ID ?? String(process.pid)
}

function jsonResponse(
  response: ServerResponse,
  body: unknown,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization

  if (!authorization?.startsWith('Bearer ')) {
    return false
  }

  const presentedToken = authorization.slice('Bearer '.length).trim()
  if (presentedToken.length === 0) {
    return false
  }

  const expectedBuffer = Buffer.from(token)
  const presentedBuffer = Buffer.from(presentedToken)

  if (expectedBuffer.length !== presentedBuffer.length) {
    return false
  }

  return timingSafeEqual(expectedBuffer, presentedBuffer)
}

function summarizeIssues(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ')
}

function countToolCalls(events: ParsedEvent[] | undefined): number {
  return (events ?? []).filter((event) => event.type === 'tool_use').length
}

function mapTask(
  task: RpcTaskRecord,
  now: () => number,
): TasksListResponse['tasks'][number] {
  const elapsedEnd = typeof task.endedAt === 'number' ? task.endedAt : now()

  return {
    taskId: task.taskId,
    status: task.status === 'running' ? 'running' : 'complete',
    agent: task.agentName ?? '',
    model: task.modelName ?? '',
    elapsedMs: Math.max(0, Math.trunc(elapsedEnd - task.startedAt)),
    toolCallCount: countToolCalls(task.events),
    startedAt: Math.max(0, Math.trunc(task.startedAt)),
  }
}

async function writePortFile(
  portFilePath: string,
  port: number,
  token: string,
) {
  const processDir = dirname(portFilePath)
  await mkdir(processDir, { recursive: true, mode: 0o700 })
  await chmod(processDir, 0o700)

  const portFile = PortFileSchema.parse({
    port,
    pid: process.pid,
    token,
  })
  const tempPath = `${portFilePath}.tmp.${randomBytes(8).toString('hex')}`

  await writeFile(tempPath, JSON.stringify(portFile), { mode: 0o600 })
  await rename(tempPath, portFilePath)
  await chmod(portFilePath, 0o600)
}

async function removePortFile(portFilePath: string): Promise<void> {
  await rm(portFilePath, { force: true })
}

type BodyParseResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; error: string }

type ValidatedBodyParseResult<T> =
  | { ok: true; body: T }
  | { ok: false; status: number; error: string }

function parseJsonBody(request: IncomingMessage): Promise<BodyParseResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    let totalBytes = 0

    function settle(result: BodyParseResult): void {
      if (settled) return
      settled = true
      resolve(result)
    }

    request.on('data', (chunk: Buffer) => {
      if (settled) return

      totalBytes += chunk.length

      if (totalBytes > MAX_JSON_BODY_BYTES) {
        settle({ ok: false, status: 413, error: 'request body too large' })
        return
      }

      chunks.push(chunk)
    })

    request.on('end', () => {
      if (settled) return

      try {
        settle({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString()) })
      } catch {
        settle({ ok: false, status: 400, error: 'invalid JSON body' })
      }
    })

    request.on('error', () => {
      if (!settled) {
        settle({ ok: false, status: 400, error: 'invalid request body' })
      }
    })
  })
}

async function parseValidatedJsonBody<T>(
  request: IncomingMessage,
  schema: ZodType<T>,
): Promise<ValidatedBodyParseResult<T>> {
  const parsed = await parseJsonBody(request)
  if (!parsed.ok) return parsed

  const validated = schema.safeParse(parsed.body)
  if (!validated.success) {
    return { ok: false, status: 400, error: summarizeIssues(validated.error) }
  }

  return { ok: true, body: validated.data }
}

function handleHealth(response: ServerResponse): void {
  jsonResponse(
    response,
    HealthResponseSchema.parse({ ok: true, version: packageVersion }),
  )
}

function handleTasksList(
  response: ServerResponse,
  taskRegistry: TaskRegistryLike,
  now: () => number,
): void {
  const body = TasksListResponseSchema.parse({
    tasks: taskRegistry
      .getAllTasks()
      .filter((task) => task.status === 'running')
      .map((task) => mapTask(task, now)),
  })

  jsonResponse(response, body)
}

async function handleTasksCancel(
  request: IncomingMessage,
  response: ServerResponse,
  cancelTaskById: StartRpcServerOptions['cancelTaskById'],
): Promise<void> {
  const parsedBody = await parseValidatedJsonBody(
    request,
    TasksCancelRequestSchema,
  )

  if (!parsedBody.ok) {
    jsonResponse(response, { error: parsedBody.error }, parsedBody.status)
    return
  }

  const result = TasksCancelResponseSchema.parse(
    await cancelTaskById(parsedBody.body.taskId),
  )

  if (!result.cancelled && result.error === 'no such task') {
    jsonResponse(response, result, 404)
    return
  }

  jsonResponse(response, result)
}

export async function startRpcServer(
  options: StartRpcServerOptions,
): Promise<StartedRpcServer> {
  const portFileBaseDir = options.portFileBaseDir ?? defaultPortFileBaseDir()
  const sessionDiscriminator =
    options.sessionDiscriminator ?? defaultSessionDiscriminator()
  const portFilePath = join(
    portFileBaseDir,
    sessionDiscriminator,
    'server-port.json',
  )
  const portFileDir = dirname(portFilePath)
  const token = randomBytes(32).toString('base64url')
  const now = options.now ?? Date.now
  let portFileWritten = false

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === '/health' && request.method === 'GET') {
      handleHealth(response)
      return
    }

    if (!isAuthorized(request, token)) {
      jsonResponse(response, { error: 'unauthorized' }, 401)
      return
    }

    if (url.pathname === '/tasks/list' && request.method === 'POST') {
      handleTasksList(response, options.taskRegistry, now)
      return
    }

    if (url.pathname === '/tasks/cancel' && request.method === 'POST') {
      await handleTasksCancel(request, response, options.cancelTaskById)
      return
    }

    jsonResponse(response, { error: 'not found' }, 404)
  })

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve()
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    }).catch(() => {})

    if (portFileWritten) {
      await removePortFile(portFilePath).catch(() => {})
      portFileWritten = false
    }
  }

  try {
    await rm(portFileDir, { force: true, recursive: true })

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address() as AddressInfo
        resolve(address.port)
      })
    })

    await writePortFile(portFilePath, port, token)
    portFileWritten = true

    return { port, token, close }
  } catch (error) {
    await close()
    throw error
  }
}
