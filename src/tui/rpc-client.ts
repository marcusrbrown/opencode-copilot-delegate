import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ZodIssue, ZodType } from 'zod'
import {
  type HealthResponse,
  HealthResponseSchema,
  type PortFile,
  PortFileSchema,
  TasksCancelRequestSchema,
  type TasksCancelResponse,
  TasksCancelResponseSchema,
  type TasksListResponse,
  TasksListResponseSchema,
} from '../runtime/rpc-contract'

type CreateRpcClientOptions = {
  baseDir?: string
  sessionDiscriminator?: string
  fetchImpl?: typeof fetch
}

type RequestOptions<T> = {
  method: 'GET' | 'POST'
  path: string
  schema: ZodType<T>
  authenticated?: boolean
  body?: unknown
}

type RpcRequestContext = {
  path: string
  url: string
}

export class RpcUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RpcUnreachableError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class RpcValidationError extends Error {
  readonly issues?: string[]

  constructor(
    message: string,
    options?: { cause?: unknown; issues?: string[] },
  ) {
    super(message, options)
    this.name = 'RpcValidationError'
    this.issues = options?.issues
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class RpcServerError extends Error {
  readonly status: number
  readonly path: string

  constructor(
    message: string,
    options: { cause?: unknown; path: string; status: number },
  ) {
    super(message, options)
    this.name = 'RpcServerError'
    this.status = options.status
    this.path = options.path
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class RpcAuthError extends RpcServerError {
  constructor(
    message: string,
    options: { cause?: unknown; path: string; status: number },
  ) {
    super(message, options)
    this.name = 'RpcAuthError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

function defaultBaseDir(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? homedir(), '.cache')

  return join(cacheHome, 'opencode', 'copilot-delegate')
}

function defaultSessionDiscriminator(): string {
  return process.env.OPENCODE_SESSION_ID ?? String(process.pid)
}

function resolvePortFilePath(options: CreateRpcClientOptions): string {
  return join(
    options.baseDir ?? defaultBaseDir(),
    options.sessionDiscriminator ?? defaultSessionDiscriminator(),
    'server-port.json',
  )
}

function summarizeIssues(issues: ZodIssue[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  return String(error)
}

async function readPortFile(portFilePath: string): Promise<PortFile> {
  let raw: string

  try {
    raw = await readFile(portFilePath, 'utf8')
  } catch (error) {
    throw new RpcUnreachableError(
      `Copilot delegate RPC port file is unavailable at ${portFilePath}`,
      { cause: error },
    )
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new RpcValidationError(
      `Copilot delegate RPC port file contains invalid JSON at ${portFilePath}`,
      { cause: error },
    )
  }

  const validated = PortFileSchema.safeParse(parsed)
  if (!validated.success) {
    const issues = summarizeIssues(validated.error.issues)

    throw new RpcValidationError(
      `Copilot delegate RPC port file is invalid at ${portFilePath}: ${issues.join('; ')}`,
      {
        cause: validated.error,
        issues,
      },
    )
  }

  return validated.data
}

async function parseOkResponse(response: Response, context: RpcRequestContext) {
  const text = await response.text()

  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new RpcValidationError(
      `Copilot delegate RPC returned invalid JSON for ${context.path} (${context.url})`,
      { cause: error },
    )
  }
}

async function parseErrorResponse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function buildServerErrorMessage(
  response: Response,
  context: RpcRequestContext,
  body: unknown,
): string {
  let detail = ''

  if (typeof body === 'string' && body.trim().length > 0) {
    detail = body.trim()
  } else if (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'string' &&
    body.error.length > 0
  ) {
    detail = body.error
  }

  const prefix =
    response.status === 401
      ? `Copilot delegate RPC authorization failed for ${context.path} (${context.url}) with status ${response.status}`
      : `Copilot delegate RPC request failed for ${context.path} (${context.url}) with status ${response.status}`

  return detail ? `${prefix}: ${detail}` : prefix
}

function validateBody<T>(
  schema: ZodType<T>,
  parsed: unknown,
  context: RpcRequestContext,
): T {
  const validated = schema.safeParse(parsed)
  if (!validated.success) {
    const issues = summarizeIssues(validated.error.issues)

    throw new RpcValidationError(
      `Copilot delegate RPC response for ${context.path} is invalid: ${issues.join('; ')}`,
      {
        cause: validated.error,
        issues,
      },
    )
  }

  return validated.data
}

function validateCancelTaskId(taskId: string): { taskId: string } {
  const validated = TasksCancelRequestSchema.safeParse({ taskId })
  if (!validated.success) {
    const issues = summarizeIssues(validated.error.issues)

    throw new RpcValidationError(
      `Copilot delegate RPC cancel request is invalid: ${issues.join('; ')}`,
      {
        cause: validated.error,
        issues,
      },
    )
  }

  return validated.data
}

export function createRpcClient(options: CreateRpcClientOptions = {}) {
  const portFilePath = resolvePortFilePath(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const abortController = new AbortController()

  async function request<T>(requestOptions: RequestOptions<T>): Promise<T> {
    const portFile = await readPortFile(portFilePath)
    const url = `http://127.0.0.1:${portFile.port}${requestOptions.path}`
    const context = { path: requestOptions.path, url }
    const headers = new Headers()

    if (requestOptions.authenticated) {
      headers.set('Authorization', `Bearer ${portFile.token}`)
    }

    if (requestOptions.method === 'POST') {
      headers.set('content-type', 'application/json')
    }

    let response: Response

    try {
      response = await fetchImpl(url, {
        method: requestOptions.method,
        headers,
        body:
          requestOptions.method === 'POST'
            ? JSON.stringify(requestOptions.body ?? {})
            : undefined,
        signal: abortController.signal,
      })
    } catch (error) {
      throw new RpcUnreachableError(
        `Failed to reach Copilot delegate RPC at ${url}: ${errorMessage(error)}`,
        { cause: error },
      )
    }

    if (!response.ok) {
      const body = await parseErrorResponse(response)
      const message = buildServerErrorMessage(response, context, body)

      if (response.status === 401) {
        throw new RpcAuthError(message, {
          path: requestOptions.path,
          status: response.status,
        })
      }

      throw new RpcServerError(message, {
        path: requestOptions.path,
        status: response.status,
      })
    }

    return validateBody(
      requestOptions.schema,
      await parseOkResponse(response, context),
      context,
    )
  }

  return {
    health(): Promise<HealthResponse> {
      return request({
        method: 'GET',
        path: '/health',
        schema: HealthResponseSchema,
      })
    },

    tasksList(): Promise<TasksListResponse> {
      return request({
        method: 'POST',
        path: '/tasks/list',
        authenticated: true,
        body: {},
        schema: TasksListResponseSchema,
      })
    },

    tasksCancel(taskId: string): Promise<TasksCancelResponse> {
      return request({
        method: 'POST',
        path: '/tasks/cancel',
        authenticated: true,
        body: validateCancelTaskId(taskId),
        schema: TasksCancelResponseSchema,
      })
    },

    dispose(): void {
      abortController.abort()
    },
  }
}

export type RpcClient = ReturnType<typeof createRpcClient>
