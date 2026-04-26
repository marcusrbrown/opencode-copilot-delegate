import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeClient } from './helpers/client'
import { type ServerHandle, startServer } from './helpers/server'

const REPO_ROOT = resolve(import.meta.dir, '..', '..')
const PLUGIN_DIST = join(REPO_ROOT, 'dist', 'index.js')

function makeProjectDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  const pluginDir = join(dir, '.opencode', 'plugins')
  mkdirSync(pluginDir, { recursive: true })
  copyFileSync(PLUGIN_DIST, join(pluginDir, 'copilot-delegate.js'))
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'integration-fixture', version: '0.0.0', type: 'module' }, null, 2)}\n`,
  )
  return dir
}

describe('opencode-copilot-delegate plugin (integration)', () => {
  let server: ServerHandle
  let projectDir: string

  beforeAll(async () => {
    if (!existsSync(PLUGIN_DIST)) {
      throw new Error(
        `Plugin dist not found at ${PLUGIN_DIST}. Run: bun run build`,
      )
    }
    projectDir = makeProjectDir('opencode-integration')
    server = await startServer({ cwd: projectDir })
  }, 30_000)

  afterAll(async () => {
    if (server) await server.stop()
    if (projectDir) rmSync(projectDir, { force: true, recursive: true })
  }, 10_000)

  it('starts and reports healthy', async () => {
    // Given the server has started in beforeAll
    // When we call /global/health
    const res = await fetch(`${server.baseUrl}/global/health`)
    // Then the response body indicates a healthy server with a version string
    expect(res.status).toBe(200)
    const body = (await res.json()) as { healthy: boolean; version: string }
    expect(body.healthy).toBe(true)
    expect(typeof body.version).toBe('string')
  }, 10_000)

  it('exposes copilot_delegate, copilot_output, copilot_cancel in tool ids', async () => {
    // Given a client connected to the running server
    const client = makeClient(server.baseUrl)
    // When we list tool ids
    const response = await client.tool.ids()
    const ids = response.data
    // Then all three plugin tool ids are present
    expect(ids).toBeDefined()
    expect(ids).toContain('copilot_delegate')
    expect(ids).toContain('copilot_output')
    expect(ids).toContain('copilot_cancel')
  }, 10_000)

  it('exposes correct schemas for each plugin tool via tool.list()', async () => {
    // Given a client connected to the running server
    const client = makeClient(server.baseUrl)
    // When we list tools for the always-available `opencode/big-pickle` model
    // (a free model bundled with OpenCode that requires no auth, suitable for CI).
    const response = await client.tool.list({
      query: { provider: 'opencode', model: 'big-pickle' },
    })
    const tools = response.data ?? []

    // Then each plugin tool appears with a non-empty description and a JSON-schema
    // parameters object whose `required` and `properties` keys match the source-of-truth
    // shapes defined in src/tools/*.ts.
    const byId = new Map(tools.map((t) => [t.id, t]))

    const delegate = byId.get('copilot_delegate')
    expect(delegate).toBeDefined()
    expect(delegate?.description).toMatch(/copilot/i)
    const delegateSchema = asObjectSchema(delegate?.parameters)
    expect(Object.keys(delegateSchema.properties ?? {}).sort()).toEqual([
      'add_dir',
      'agent',
      'allow_tool',
      'deny_tool',
      'model',
      'prompt',
    ])
    expect(delegateSchema.required).toEqual(['prompt'])

    const output = byId.get('copilot_output')
    expect(output).toBeDefined()
    expect(output?.description).toMatch(/copilot|output|task/i)
    const outputSchema = asObjectSchema(output?.parameters)
    expect(Object.keys(outputSchema.properties ?? {}).sort()).toEqual([
      'block',
      'task_id',
      'timeout_ms',
    ])
    expect(outputSchema.required).toEqual(['task_id'])

    const cancel = byId.get('copilot_cancel')
    expect(cancel).toBeDefined()
    expect(cancel?.description).toMatch(/cancel/i)
    const cancelSchema = asObjectSchema(cancel?.parameters)
    expect(Object.keys(cancelSchema.properties ?? {})).toEqual(['task_id'])
    expect(cancelSchema.required).toEqual(['task_id'])
  }, 15_000)
})

interface JsonObjectSchema {
  type?: unknown
  properties?: Record<string, unknown>
  required?: string[]
}

// Narrows an unknown JSON Schema parameters value to the subset we assert on.
// One cast at the JSON boundary keeps the rest of the test type-safe.
// We assert `type === 'object'` so a future SDK revision that returned an
// array schema (or any non-object discriminant) would fail loudly here
// instead of silently passing with empty properties.
function asObjectSchema(parameters: unknown): JsonObjectSchema {
  if (
    typeof parameters !== 'object' ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    throw new Error(
      `expected parameters to be a non-array object, got ${typeof parameters}`,
    )
  }
  const schema = parameters as JsonObjectSchema
  if (schema.type !== 'object') {
    throw new Error(
      `expected parameters.type === 'object', got ${String(schema.type)}`,
    )
  }
  return schema
}

describe('helpers/server resilience', () => {
  it('shuts down cleanly via stop() and leaves no zombie process', async () => {
    // Given a freshly started server
    const projectDir = makeProjectDir('opencode-stop')
    let handle: ServerHandle | undefined
    try {
      handle = await startServer({ cwd: projectDir })
      const pid = handle.pid

      // When we stop it
      await handle.stop()

      // Then the process is gone (kill(pid, 0) throws ESRCH).
      // We assert behavior, not wall-clock time — fkill's waitForExit upper bound
      // already enforces the deadline, and the bun:test outer timeout below catches hangs.
      let stillAlive = false
      try {
        process.kill(pid, 0)
        stillAlive = true
      } catch (err) {
        expect(err).toBeInstanceOf(Error)
        expect(err).toHaveProperty('code', 'ESRCH')
      }
      expect(stillAlive).toBe(false)
    } finally {
      // stop() is idempotent — a second call after PID reuse would otherwise be dangerous,
      // but the helper guards against this internally with a `stopped` flag.
      if (handle) await handle.stop().catch(() => {})
      rmSync(projectDir, { force: true, recursive: true })
    }
  }, 20_000)

  it('rejects with stderr tail if server exits before health', async () => {
    // Given a project dir spawned with a deliberately bad hostname so opencode refuses
    // to bind and exits before health responds.
    const projectDir = makeProjectDir('opencode-fail')
    try {
      // When we try to start with an unbindable host
      let caught: unknown
      try {
        await startServer({
          cwd: projectDir,
          extraArgs: ['--hostname', '256.256.256.256'],
          timeoutMs: 8_000,
        })
      } catch (err) {
        caught = err
      }

      // Then the rejection is an Error whose message contains BOTH:
      //   1. the early-exit marker (proves the exit-before-health path was taken), AND
      //   2. the stderr tail header (proves stderr capture is wired up — protects against
      //      regressions that would silently drop diagnostic content).
      expect(caught).toBeInstanceOf(Error)
      const message = (caught as Error).message
      expect(message).toMatch(/exited with code/)
      expect(message).toMatch(/stderr tail/)
    } finally {
      rmSync(projectDir, { force: true, recursive: true })
    }
  }, 15_000)

  it('throws an actionable error when the binary is missing (ENOENT)', async () => {
    // Given a non-existent binary path is passed to startServer
    const missing = '/nonexistent/path/to/opencode-test-binary-9d8f3c'
    let caught: unknown
    try {
      // When we try to start
      await startServer({ command: missing, timeoutMs: 4_000 })
    } catch (err) {
      caught = err
    }

    // Then the rejection is an Error whose message identifies the spawn failure
    // (with the ENOENT code) and includes the binary path. This protects the
    // diagnostic path against silent timeouts when opencode is not installed.
    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toMatch(/failed to spawn/i)
    expect(message).toMatch(/ENOENT/)
    expect(message).toContain(missing)
  }, 8_000)
})

describe.skip('Deferred to T7 (manual E2E) — full LLM-driven flows', () => {
  // The following plan scenarios are deferred to T7 (manual E2E in VERIFICATION.md) because
  // they require an LLM to invoke the plugin tools through a real session prompt:
  //
  // - Given a prompt that invokes copilot_delegate, the assistant message contains
  //   a task_id matching /^cpl_[0-9a-f-]+$/.
  // - Given a task_id, copilot_output with block: true returns within timeout_ms.
  // - Given a running task, copilot_cancel returns { cancelled: true, was_running: true }.
  // - Given a nonexistent task_id, copilot_output returns { status: 'unknown' }.
  // - <system-reminder> appears as a subsequent assistant turn after delegation completes.
  //
  // The underlying tool-execute logic is already covered at the unit level:
  //   - tests/tools.test.ts — task_id format, blocking timeout, cancel-running,
  //                            unknown task_id, structured error envelopes
  //   - tests/notify.test.ts — system-reminder injection and noReply semantics
  // What's deferred is end-to-end orchestration through the OpenCode session prompt path,
  // which the SDK only exposes via LLM invocation.
  it('requires LLM — see VERIFICATION.md', () => {})
})
