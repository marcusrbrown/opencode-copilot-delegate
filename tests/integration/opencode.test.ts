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
})

describe('helpers/server resilience', () => {
  it('shuts down within 5s after stop() and leaves no zombie process', async () => {
    // Given a freshly started server
    const projectDir = makeProjectDir('opencode-stop')
    let handle: ServerHandle | undefined
    try {
      handle = await startServer({ cwd: projectDir })
      const pid = handle.pid

      // When we stop it
      const start = Date.now()
      await handle.stop()
      const elapsed = Date.now() - start

      // Then it shuts down within 5s
      expect(elapsed).toBeLessThan(5000)

      // And the process is gone (kill(pid, 0) throws ESRCH)
      let stillAlive = false
      try {
        process.kill(pid, 0)
        stillAlive = true
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        expect(e.code).toBe('ESRCH')
      }
      expect(stillAlive).toBe(false)
    } finally {
      if (handle) await handle.stop().catch(() => {})
      rmSync(projectDir, { force: true, recursive: true })
    }
  }, 20_000)

  it('rejects with stderr tail if server exits before health', async () => {
    // Given a project dir with no plugin (still valid) but spawned with a deliberately bad
    // hostname that opencode will refuse to bind. Use --hostname with an invalid IP to trigger
    // an early exit before health responds.
    const projectDir = makeProjectDir('opencode-fail')
    try {
      // When we try to start with an unbindable host
      const promise = startServer({
        cwd: projectDir,
        extraArgs: ['--hostname', '256.256.256.256'],
        timeoutMs: 8_000,
      })
      // Then it rejects with an error mentioning the early exit
      await expect(promise).rejects.toThrow(
        /exited|listen|EADDR|invalid|hostname/i,
      )
    } finally {
      rmSync(projectDir, { force: true, recursive: true })
    }
  }, 15_000)
})

describe.skip('Deferred to T7 (manual E2E) — requires real LLM session', () => {
  // The following plan scenarios cannot be automated without a configured LLM provider
  // and API key in CI. They live in `VERIFICATION.md` (T7) instead:
  //
  // - Given a prompt that invokes copilot_delegate, the assistant message contains
  //   a task_id matching /^cpl_[0-9a-f-]+$/.
  // - Given a task_id, copilot_output with block: true returns within timeout_ms.
  // - Given a running task, copilot_cancel returns { cancelled: true, was_running: true }.
  // - Given a nonexistent task_id, copilot_output returns { status: 'unknown' }.
  // - <system-reminder> appears as a subsequent assistant turn after delegation completes.
  it('requires LLM — see VERIFICATION.md', () => {})
})
