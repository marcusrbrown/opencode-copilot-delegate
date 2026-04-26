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
import type { Part, ToolPart } from '@opencode-ai/sdk'
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

// LLM-driven integration tests exercise the full session-prompt path: an LLM (big-pickle)
// invokes the plugin tools through a real OpenCode session, and we assert on the tool-state
// outputs. These tests require GH_TOKEN to be set (the Copilot CLI auth chain); otherwise
// the entire describe block is skipped so `bun test` stays green on dev machines without
// the secret.
//
// big-pickle is OpenCode's bundled, no-auth, free model. It supports function calling.
// The Copilot subprocess that copilot_delegate spawns does cost premium requests against
// the user's Copilot subscription — we keep prompts trivial ("reply with ok") and cancel
// running tasks early to bound the burn rate.
//
// Process-tree teardown in afterAll guarantees no Copilot subprocess outlives the suite,
// even if a per-test cancel didn't fire.

// Resolve the Copilot CLI auth token from either env var: GH_TOKEN (CI convention,
// what the Copilot CLI itself reads) or COPILOT_PAT (the secret name in the repo
// and the convention Marcus uses in his local .env). If only COPILOT_PAT is set,
// we forward it to GH_TOKEN before spawning opencode so the spawned `copilot`
// subprocess can authenticate.
const COPILOT_AUTH = process.env.GH_TOKEN ?? process.env.COPILOT_PAT

describe.skipIf(!COPILOT_AUTH)(
  'LLM-driven integration (requires COPILOT_PAT or GH_TOKEN)',
  () => {
    let server: ServerHandle
    let projectDir: string

    beforeAll(async () => {
      if (!existsSync(PLUGIN_DIST)) {
        throw new Error(
          `Plugin dist not found at ${PLUGIN_DIST}. Run: bun run build`,
        )
      }
      projectDir = makeProjectDir('opencode-llm')
      // Forward auth scoped to the opencode subprocess (and its copilot grandchildren).
      // We don't mutate process.env here — that would persist across test files in the
      // same `bun test` invocation and create implicit coupling.
      const env: Record<string, string> = {}
      if (!process.env.GH_TOKEN && COPILOT_AUTH) {
        env.GH_TOKEN = COPILOT_AUTH
      }
      server = await startServer({ cwd: projectDir, env })
    }, 30_000)

    afterAll(async () => {
      if (server) await server.stop()
      if (projectDir) rmSync(projectDir, { force: true, recursive: true })
    }, 15_000)

    // Helper: send a prompt to big-pickle and return assistant parts from messages
    // produced by this turn. We can't rely on session.prompt's response parts alone
    // because tool calls happen across multiple assistant messages — each LLM "step"
    // is its own message. We snapshot the message count before, then slice off only
    // the messages this prompt produced.
    async function promptBigPickle(
      sessionId: string,
      text: string,
    ): Promise<readonly Part[]> {
      const client = makeClient(server.baseUrl)
      const before = await client.session.messages({
        path: { id: sessionId },
      })
      const beforeLength = (before.data ?? []).length

      await client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: 'opencode', modelID: 'big-pickle' },
          parts: [{ type: 'text', text }],
        },
      })

      const after = await client.session.messages({
        path: { id: sessionId },
      })
      const newMessages = (after.data ?? []).slice(beforeLength)

      const parts: Part[] = []
      for (const m of newMessages) {
        if (m.info?.role === 'assistant') {
          for (const p of m.parts ?? []) parts.push(p)
        }
      }
      return parts
    }

    async function newSession(): Promise<string> {
      const client = makeClient(server.baseUrl)
      const created = await client.session.create({ body: {} })
      const id = created.data?.id
      if (!id) {
        throw new Error('session.create returned no id')
      }
      return id
    }

    function findToolCalls(
      parts: readonly Part[],
      toolName: string,
    ): readonly ToolPart[] {
      return parts.filter(
        (p): p is ToolPart => p.type === 'tool' && p.tool === toolName,
      )
    }

    function findToolCall(parts: readonly Part[], toolName: string): ToolPart {
      const matches = findToolCalls(parts, toolName)
      const part = matches[0]
      if (!part) {
        const seen = parts.map((p) => p.type).join(', ')
        throw new Error(
          `expected a ${toolName} tool part in assistant response; saw: ${seen}`,
        )
      }
      return part
    }

    // Find a tool call whose input matches a predicate. Returns undefined if none match;
    // the LLM may produce multiple calls to the same tool (e.g. polling output without
    // block:true before calling with block:true).
    function findToolCallWhere(
      parts: readonly Part[],
      toolName: string,
      predicate: (input: Record<string, unknown>) => boolean,
    ): ToolPart | undefined {
      return findToolCalls(parts, toolName).find((p) => {
        const input = (p.state as { input?: Record<string, unknown> }).input
        return input ? predicate(input) : false
      })
    }

    function parseToolOutput<T>(part: ToolPart): T {
      if (part.state.status !== 'completed') {
        throw new Error(
          `expected tool ${part.tool} to complete, got status=${part.state.status}`,
        )
      }
      try {
        return JSON.parse(part.state.output) as T
      } catch (err) {
        throw new Error(
          `failed to parse tool output as JSON: ${(err as Error).message}\nraw: ${part.state.output}`,
        )
      }
    }

    // Best-effort cancel via LLM. Failures here are non-fatal — the afterAll process-tree
    // teardown is the safety net.
    async function bestEffortCancel(
      sessionId: string,
      taskId: string,
    ): Promise<void> {
      try {
        await promptBigPickle(
          sessionId,
          `Call the copilot_cancel tool with task_id "${taskId}". Respond with just "done".`,
        )
      } catch {
        // Swallow — process-tree teardown handles leaks.
      }
    }

    it('returns a task_id matching /^cpl_[0-9a-f-]+$/ when copilot_delegate is invoked', async () => {
      // Given a fresh session
      const sessionId = await newSession()
      let taskId: string | undefined
      try {
        // When we ask the LLM to invoke copilot_delegate
        const parts = await promptBigPickle(
          sessionId,
          'Use the copilot_delegate tool with prompt "reply with the word ok and exit". Just call the tool, do not explain.',
        )
        // Then a tool part exists with the expected output shape. The delegate
        // tool's contract is `{ task_id }` — status is observed via copilot_output.
        const toolPart = findToolCall(parts, 'copilot_delegate')
        const output = parseToolOutput<{ task_id: string }>(toolPart)
        expect(output.task_id).toMatch(/^cpl_[0-9a-f-]+$/)
        taskId = output.task_id
      } finally {
        if (taskId) await bestEffortCancel(sessionId, taskId)
      }
    }, 60_000)

    it('returns timed_out: true when copilot_output is called with block: true and a short timeout', async () => {
      // Given a single LLM turn that delegates AND immediately blocks on output. The single-
      // turn approach bypasses big-pickle's auto-polling: when called as separate prompts, the
      // LLM polls copilot_output until completion before returning, leaving no opportunity to
      // observe the running state. By telling the LLM in one prompt to delegate then call
      // output with block:true, we capture the block call before the auto-poll loop kicks in.
      const sessionId = await newSession()
      let taskId: string | undefined
      try {
        const parts = await promptBigPickle(
          sessionId,
          'Do these two things in order, then stop: (1) call copilot_delegate with prompt "Generate a detailed 1000-word essay about the history of programming languages."; (2) immediately call copilot_output with the task_id from step 1, block: true, and timeout_ms: 2000. Do not call any other tools and do not explain.',
        )

        const startTool = findToolCall(parts, 'copilot_delegate')
        const startOutput = parseToolOutput<{ task_id: string }>(startTool)
        taskId = startOutput.task_id
        expect(taskId).toMatch(/^cpl_[0-9a-f-]+$/)

        // Find the output call with block:true (LLM may also have polled without block first).
        const outTool = findToolCallWhere(
          parts,
          'copilot_output',
          (input) => input.block === true,
        )
        if (!outTool) {
          const seen = parts
            .filter(
              (p): p is ToolPart =>
                p.type === 'tool' && p.tool === 'copilot_output',
            )
            .map((p) =>
              JSON.stringify((p.state as { input?: unknown }).input ?? null),
            )
            .join('; ')
          throw new Error(
            `expected a copilot_output call with block:true; saw: ${seen}`,
          )
        }
        const outOutput = parseToolOutput<{
          status: string
          timed_out?: boolean
        }>(outTool)

        // Then the response indicates a timeout (task is still running)
        expect(outOutput.timed_out).toBe(true)
        expect(outOutput.status).toBe('running')
      } finally {
        if (taskId) await bestEffortCancel(sessionId, taskId)
      }
    }, 120_000)

    it('returns { cancelled: true, was_running: true } when copilot_cancel is called on a running task', async () => {
      // Given a long-running task delegated AND cancelled in a single LLM turn — this minimizes
      // the race window where the copilot subprocess could complete before cancel is called.
      // We use a substantial prompt to ensure the subprocess takes long enough that even after
      // the LLM round-trip for cancel, the task is still running.
      const sessionId = await newSession()
      const parts = await promptBigPickle(
        sessionId,
        'Do these two things in order: (1) call copilot_delegate with prompt "Generate a 2000-word essay about quantum mechanics. Be thorough and take your time."; (2) immediately call copilot_cancel with the task_id from step 1. Do not call any other tools and do not explain.',
      )

      const startTool = findToolCall(parts, 'copilot_delegate')
      const startOutput = parseToolOutput<{ task_id: string }>(startTool)
      const taskId = startOutput.task_id
      expect(taskId).toMatch(/^cpl_[0-9a-f-]+$/)

      // When we look for the cancel call (the LLM might invoke copilot_cancel before
      // copilot_output, or after some output polls — find any cancel tool call)
      const cancelTool = findToolCall(parts, 'copilot_cancel')

      // Then the cancel succeeded against a still-running task. If the subprocess completed
      // first (unlikely with the long prompt + same-turn cancel), this assertion fails loudly.
      const cancelOutput = parseToolOutput<{
        cancelled: boolean
        was_running: boolean
      }>(cancelTool)
      expect(cancelOutput.cancelled).toBe(true)
      expect(cancelOutput.was_running).toBe(true)
    }, 90_000)

    it('returns { status: "unknown" } when copilot_output is called with a nonexistent task_id', async () => {
      // Given a fresh session and a fabricated task_id
      const sessionId = await newSession()
      const fakeId = 'cpl_00000000-0000-0000-0000-000000000000'

      // When we ask the LLM to call copilot_output for it
      const parts = await promptBigPickle(
        sessionId,
        `Use the copilot_output tool with task_id "${fakeId}". Just call the tool, do not explain.`,
      )

      // Then the response status is unknown — no premium request burned (no delegation)
      const toolPart = findToolCall(parts, 'copilot_output')
      const output = parseToolOutput<{ status: string }>(toolPart)
      expect(output.status).toBe('unknown')
    }, 30_000)

    interface SyntheticReminder {
      synthetic?: boolean
      text: string
    }

    // Find a system-reminder text part referencing the given taskId. We match by content
    // (the <system-reminder> tag and the taskId) rather than asserting synthetic === true,
    // because the SDK's serialization of the synthetic flag is not contractually stable.
    // The plugin sets synthetic: true when injecting (verified by unit tests in
    // tests/notify.test.ts); whether that flag round-trips through session.messages is
    // an SDK implementation detail. Behavior we care about: the reminder appears in the
    // session, contains the task_id, and is wrapped in the <system-reminder> tag.
    function findReminderInMessages(
      messages: ReadonlyArray<{ parts?: readonly Part[] }>,
      taskId: string,
    ): SyntheticReminder | undefined {
      for (const message of messages) {
        for (const part of message.parts ?? []) {
          if (
            part.type === 'text' &&
            part.text.includes('<system-reminder>') &&
            part.text.includes(taskId)
          ) {
            return part
          }
        }
      }
      return undefined
    }

    async function pollForReminder(
      sessionId: string,
      taskId: string,
      timeoutMs: number,
    ): Promise<SyntheticReminder | undefined> {
      const client = makeClient(server.baseUrl)
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const messagesResp = await client.session.messages({
          path: { id: sessionId },
        })
        const messages = messagesResp.data ?? []
        const found = findReminderInMessages(messages, taskId)
        if (found) return found
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      return undefined
    }

    it('injects a <system-reminder> assistant turn after delegation completes', async () => {
      // Given a delegated task that completes quickly (~5s)
      const sessionId = await newSession()
      const startParts = await promptBigPickle(
        sessionId,
        'Use the copilot_delegate tool with prompt "respond with just the word ok". Just call the tool, do not explain.',
      )
      const startTool = findToolCall(startParts, 'copilot_delegate')
      const startOutput = parseToolOutput<{ task_id: string }>(startTool)
      const taskId = startOutput.task_id

      // When we wait for the plugin's notification.ts to inject a synthetic <system-reminder>
      // referencing this task_id. Notification path: completionPromise.then → notifyCompletion
      // → client.session.prompt({ noReply, parts: [text + synthetic:true] }). When the parent
      // session has no other in-flight tasks, noReply is false, which causes opencode to also
      // kick off an LLM response — the await blocks on that. The reminder text is added to the
      // session as soon as opencode accepts the prompt, but observing it via session.messages
      // can lag by up to 60s in slow runs (LLM response generation, network round-trips).
      const found = await pollForReminder(sessionId, taskId, 60_000)

      // Then the reminder text appears in the session referencing this taskId. The
      // synthetic flag is informational — we don't assert it because SDK round-trip
      // serialization of that flag is not contractually stable.
      if (!found) {
        throw new Error(
          `expected <system-reminder> for ${taskId} within 60s; none found in session messages`,
        )
      }
      expect(found.text).toContain('<system-reminder>')
      expect(found.text).toContain(taskId)
    }, 90_000)
  },
)
