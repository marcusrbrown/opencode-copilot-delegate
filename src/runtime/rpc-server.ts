import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { ZodError, ZodType } from 'zod'
import { isErrnoException } from '../lib/errno'
import type { CancelTaskResult } from './cancel-helper'
import type { TaskStatus } from './envelope'
import type { ParsedEvent } from './jsonl-parser'
import {
  HealthResponseSchema,
  PortFileSchema,
  TasksCancelRequestSchema,
  TasksCancelResponseSchema,
  type TasksListResponse,
  TasksListResponseSchema,
} from './rpc-contract'
import {
  assertSafeSessionDiscriminator,
  defaultPortFileBaseDir,
  defaultSessionDiscriminator,
} from './rpc-paths'
import {
  type PortFileSweepOptions,
  type PortFileSweepResult,
  sweepStalePortFiles,
} from './rpc-port-sweep'

type RpcTaskRecord = {
  taskId: string
  status: TaskStatus
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
  /**
   * Receives a count-only summary when the background sweep removed stale
   * port files. Never receives paths or token values.
   */
  log?: (message: string) => void
  /** Test seams for the stale port-file sweep. */
  sweep?: Pick<
    PortFileSweepOptions,
    'graceMs' | 'maxEntries' | 'isPidAlive' | 'now'
  >
}

export type StartedRpcServer = {
  port: number
  token: string
  /** Settles when the background stale-file sweep finishes. Never rejects. */
  staleSweep: Promise<PortFileSweepResult>
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
    status: task.status,
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
  // Also drop the per-session directory so clean exits leave nothing behind.
  // Non-recursive and best-effort: it only succeeds once the directory is
  // empty, so a concurrent writer's files are never touched.
  await rmdir(dirname(portFilePath)).catch(() => {})
}

async function removeStalePortFiles(portFileDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(portFileDir)
  } catch (error) {
    if (isMissingPathError(error)) {
      return
    }
    throw error
  }

  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry === 'server-port.json' ||
          entry.startsWith('server-port.json.tmp.'),
      )
      .map((entry) => rm(join(portFileDir, entry), { force: true })),
  )
}

async function runStaleSweep(
  options: StartRpcServerOptions,
  baseDir: string,
  currentDiscriminator: string,
): Promise<PortFileSweepResult> {
  const empty: PortFileSweepResult = { scanned: 0, removed: 0, kept: 0 }

  try {
    // Yield so server start returns before any sweep I/O begins.
    await Promise.resolve()

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator,
      now: options.now,
      ...options.sweep,
    })

    if (result.removed > 0) {
      try {
        options.log?.(
          `[copilot-delegate] removed ${result.removed} stale RPC port file(s) from exited sessions`,
        )
      } catch {
        // Logging is best-effort.
      }
    }

    return result
  } catch {
    return empty
  }
}

export function isMissingPathError(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT'
}

export function getTcpServerPort(address: AddressInfo | string | null): number {
  if (address === null || typeof address === 'string') {
    throw new Error('RPC server did not bind to a TCP address')
  }

  return address.port
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
      .filter(
        (task) => task.status === 'running' || task.status === 'cancelling',
      )
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

async function handleRpcRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  options: StartRpcServerOptions,
  now: () => number,
) {
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
}

export async function startRpcServer(
  options: StartRpcServerOptions,
): Promise<StartedRpcServer> {
  const portFileBaseDir = options.portFileBaseDir ?? defaultPortFileBaseDir()
  const sessionDiscriminator =
    options.sessionDiscriminator ?? defaultSessionDiscriminator()
  assertSafeSessionDiscriminator(sessionDiscriminator)
  const portFilePath = join(
    portFileBaseDir,
    sessionDiscriminator,
    'server-port.json',
  )
  const portFileDir = dirname(portFilePath)
  const token = randomBytes(32).toString('base64url')
  const now = options.now ?? Date.now
  let portFileWritten = false
  let staleSweep: Promise<PortFileSweepResult> | undefined

  const server = createServer((request, response) => {
    void handleRpcRequest(request, response, token, options, now).catch(() => {
      if (!response.headersSent) {
        jsonResponse(response, { error: 'internal server error' }, 500)
      } else {
        response.destroy()
      }
    })
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

    // Let any in-flight sweep finish so shutdown never races it (it never
    // rejects and is bounded by maxEntries).
    await staleSweep

    if (portFileWritten) {
      await removePortFile(portFilePath).catch(() => {})
      portFileWritten = false
    }
  }

  try {
    await mkdir(portFileDir, { recursive: true, mode: 0o700 })
    await chmod(portFileDir, 0o700)
    await removeStalePortFiles(portFileDir)

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve(getTcpServerPort(server.address()))
      })
    })

    await writePortFile(portFilePath, port, token)
    portFileWritten = true

    // Sweep sibling directories only after the server is up and its own port
    // file is published, off the init critical path, and never rejecting.
    const sweepPromise = runStaleSweep(
      options,
      portFileBaseDir,
      sessionDiscriminator,
    )
    staleSweep = sweepPromise

    return { port, token, staleSweep: sweepPromise, close }
  } catch (error) {
    await close()
    throw error
  }
}
