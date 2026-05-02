import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RpcClient = {
  health(): Promise<unknown>
  tasksList(): Promise<unknown>
  tasksCancel(taskId: string): Promise<unknown>
  dispose(): void
}

type ErrorClass = abstract new (...args: unknown[]) => Error

type RpcClientModule = {
  createRpcClient(options?: {
    baseDir?: string
    sessionDiscriminator?: string
    fetchImpl?: typeof fetch
    requestTimeoutMs?: number
  }): RpcClient
  RpcUnreachableError: ErrorClass
  RpcServerError: ErrorClass
  RpcAuthError: ErrorClass
  RpcValidationError: ErrorClass
}

type RecordedRequest = {
  method: string
  url: string
  authorization?: string
  body: string
}

type StartedStubServer = {
  port: number
  requests: RecordedRequest[]
  close(): Promise<void>
}

const tempPaths: string[] = []
const startedServers: StartedStubServer[] = []

afterEach(async () => {
  for (const server of startedServers.splice(0)) {
    await server.close()
  }

  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

async function loadRpcClientModule(): Promise<RpcClientModule> {
  const module = await import('../rpc-client')
  const createRpcClient = Reflect.get(module, 'createRpcClient')
  const RpcUnreachableError = Reflect.get(module, 'RpcUnreachableError')
  const RpcServerError = Reflect.get(module, 'RpcServerError')
  const RpcAuthError = Reflect.get(module, 'RpcAuthError')
  const RpcValidationError = Reflect.get(module, 'RpcValidationError')

  expect(typeof createRpcClient).toBe('function')
  expect(typeof RpcUnreachableError).toBe('function')
  expect(typeof RpcServerError).toBe('function')
  expect(typeof RpcAuthError).toBe('function')
  expect(typeof RpcValidationError).toBe('function')

  return {
    createRpcClient: createRpcClient as RpcClientModule['createRpcClient'],
    RpcUnreachableError:
      RpcUnreachableError as RpcClientModule['RpcUnreachableError'],
    RpcServerError: RpcServerError as RpcClientModule['RpcServerError'],
    RpcAuthError: RpcAuthError as RpcClientModule['RpcAuthError'],
    RpcValidationError:
      RpcValidationError as RpcClientModule['RpcValidationError'],
  }
}

function makeCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tui-rpc-client-'))
  tempPaths.push(dir)
  return dir
}

function writePortFile(
  baseDir: string,
  sessionDiscriminator: string,
  contents: unknown,
): string {
  const sessionDir = join(baseDir, sessionDiscriminator)
  mkdirSync(sessionDir, { recursive: true })

  const portFilePath = join(sessionDir, 'server-port.json')
  writeFileSync(portFilePath, JSON.stringify(contents))

  return portFilePath
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', reject)
  })
}

function respondJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startStubServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    requests: RecordedRequest[],
  ) => Promise<void> | void,
): Promise<StartedStubServer> {
  const requests: RecordedRequest[] = []

  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request)
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      authorization: request.headers.authorization,
      body,
    })

    await handler(request, response, requests)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })

  const started: StartedStubServer = {
    port,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
  }

  startedServers.push(started)
  return started
}

async function captureError<T>(promise: Promise<T>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }

  throw new Error('Expected promise to reject')
}

describe('tui rpc client', () => {
  it('reads a valid port file and returns parsed health responses', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((_request, response) => {
      respondJson(response, 200, { ok: true, version: '0.9.0' })
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'session-a', {
      port: server.port,
      pid: process.pid,
      token: 'token-health',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'session-a',
    })

    expect(await client.health()).toEqual({ ok: true, version: '0.9.0' })
    expect(server.requests).toEqual([
      {
        method: 'GET',
        url: '/health',
        authorization: undefined,
        body: '',
      },
    ])
  })

  it('rejects missing port files with a clear unreachable error', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const baseDir = makeCacheDir()
    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'missing-session',
    })

    const error = await captureError(client.health())

    expect(error).toBeInstanceOf(rpcClientModule.RpcUnreachableError)
    expect((error as Error).message).toContain('server-port.json')
  })

  it('rejects invalid port file schemas with a clear validation error', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'invalid-port-file', {
      port: 43123,
      pid: process.pid,
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'invalid-port-file',
    })

    const error = await captureError(client.health())

    expect(error).toBeInstanceOf(rpcClientModule.RpcValidationError)
    expect((error as Error).message).toContain('token')
  })

  it('sends bearer auth for tasksList and tasksCancel', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((request, response) => {
      if (request.url === '/tasks/list') {
        respondJson(response, 200, { tasks: [] })
        return
      }

      if (request.url === '/tasks/cancel') {
        respondJson(response, 200, { cancelled: true })
        return
      }

      respondJson(response, 404, { error: 'not found' })
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'auth-session', {
      port: server.port,
      pid: process.pid,
      token: 'token-auth',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'auth-session',
    })

    expect(await client.tasksList()).toEqual({ tasks: [] })
    expect(await client.tasksCancel('cpl_auth-task')).toEqual({
      cancelled: true,
    })
    expect(server.requests).toEqual([
      {
        method: 'POST',
        url: '/tasks/list',
        authorization: 'Bearer token-auth',
        body: '{}',
      },
      {
        method: 'POST',
        url: '/tasks/cancel',
        authorization: 'Bearer token-auth',
        body: '{"taskId":"cpl_auth-task"}',
      },
    ])
  })

  it('turns 401 responses into auth errors', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((_request, response) => {
      respondJson(response, 401, { error: 'unauthorized' })
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'auth-failure', {
      port: server.port,
      pid: process.pid,
      token: 'token-auth-failure',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'auth-failure',
    })

    const error = await captureError(client.tasksList())

    expect(error).toBeInstanceOf(rpcClientModule.RpcAuthError)
    expect((error as Error & { status?: number }).status).toBe(401)
  })

  it('turns 500 responses into status-aware server errors', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((_request, response) => {
      respondJson(response, 500, { error: 'server exploded' })
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'server-failure', {
      port: server.port,
      pid: process.pid,
      token: 'token-server-failure',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'server-failure',
    })

    const error = await captureError(client.tasksCancel('cpl_server-task'))

    expect(error).toBeInstanceOf(rpcClientModule.RpcServerError)
    expect(error).not.toBeInstanceOf(rpcClientModule.RpcAuthError)
    expect((error as Error & { status?: number }).status).toBe(500)
  })

  it('rejects invalid JSON responses', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"tasks":')
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'invalid-json', {
      port: server.port,
      pid: process.pid,
      token: 'token-invalid-json',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'invalid-json',
    })

    const error = await captureError(client.tasksList())

    expect(error).toBeInstanceOf(rpcClientModule.RpcValidationError)
    expect((error as Error).message).toContain('JSON')
  })

  it('rejects invalid response schemas', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const server = await startStubServer((_request, response) => {
      respondJson(response, 200, {
        tasks: [
          {
            taskId: 'task-without-prefix',
            status: 'running',
            agent: 'default',
            model: 'gpt-5',
            elapsedMs: 5,
            toolCallCount: 1,
            startedAt: 1,
          },
        ],
      })
    })
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'invalid-response', {
      port: server.port,
      pid: process.pid,
      token: 'token-invalid-response',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'invalid-response',
    })

    const error = await captureError(client.tasksList())

    expect(error).toBeInstanceOf(rpcClientModule.RpcValidationError)
    expect((error as Error).message).toContain('taskId')
  })

  it('turns fetch failures into unreachable errors', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const baseDir = makeCacheDir()

    writePortFile(baseDir, 'network-failure', {
      port: 65_000,
      pid: process.pid,
      token: 'token-network-failure',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'network-failure',
    })

    const error = await captureError(client.health())

    expect(error).toBeInstanceOf(rpcClientModule.RpcUnreachableError)
    expect((error as Error).message).toContain('127.0.0.1')
  })

  it('aborts in-flight requests when disposed', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const baseDir = makeCacheDir()
    let capturedSignal: AbortSignal | undefined

    writePortFile(baseDir, 'dispose-session', {
      port: 43123,
      pid: process.pid,
      token: 'token-dispose',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'dispose-session',
      fetchImpl: ((_input, init) => {
        capturedSignal = init?.signal as AbortSignal | undefined

        return new Promise<Response>((_resolve, reject) => {
          if (capturedSignal?.aborted) {
            reject(new Error('aborted'))
            return
          }

          capturedSignal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted'))
            },
            { once: true },
          )
        })
      }) as typeof fetch,
    })

    const pending = client.tasksList()
    client.dispose()

    const error = await captureError(pending)

    expect(capturedSignal?.aborted).toBe(true)
    expect(error).toBeInstanceOf(rpcClientModule.RpcUnreachableError)
    expect((error as Error).message).toContain('aborted')
  })

  it('times out in-flight requests that never resolve', async () => {
    const rpcClientModule = await loadRpcClientModule()
    const baseDir = makeCacheDir()
    let capturedSignal: AbortSignal | undefined

    writePortFile(baseDir, 'timeout-session', {
      port: 43123,
      pid: process.pid,
      token: 'token-timeout',
    })

    const client = rpcClientModule.createRpcClient({
      baseDir,
      sessionDiscriminator: 'timeout-session',
      requestTimeoutMs: 1,
      fetchImpl: ((_input, init) => {
        capturedSignal = init?.signal as AbortSignal | undefined

        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener(
            'abort',
            () => {
              reject(new Error('aborted by timeout'))
            },
            { once: true },
          )
        })
      }) as typeof fetch,
    })

    const error = await captureError(client.tasksList())

    expect(capturedSignal?.aborted).toBe(true)
    expect(error).toBeInstanceOf(rpcClientModule.RpcUnreachableError)
    expect((error as Error).message).toContain('aborted by timeout')
  })
})
