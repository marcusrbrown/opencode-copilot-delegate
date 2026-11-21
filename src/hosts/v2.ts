import type { Plugin } from '@opencode/plugin'
import type { ToolContext } from '@opencode/plugin/promise/tool'
import type { ToolContext as V1ToolContext } from '@opencode-ai/plugin/tool'
import { z } from 'zod'
import { initializeProcess, type LogSink } from '../core/process'
import { buildTools, type CopilotTools } from '../core/tools'
import type { InjectMode, NotifyClient } from '../runtime/notify'
import { acquireProcessCore, releaseProcessCore } from '../runtime/process-core'

const LOG_PREFIX = 'opencode-copilot-delegate:'

/** V2 has no logging API; plugin logs go to stderr. No secrets in messages. */
const stderrLog: LogSink = (level, message) => {
  console.error(`${LOG_PREFIX} [${level}] ${message}`)
}

type SyntheticDelivery =
  | { resume: false }
  | { delivery: 'queue' }
  | { delivery: 'steer' }

/**
 * Map a completion mode to `session.synthetic` arguments (plan, Key
 * Technical Decisions → V2 notifications):
 * - `silent`: `resume: false`, admitted without waking the session (the V1
 *   `noReply: true` analogue).
 * - `final`: `delivery: 'queue'`, which waits for the active turn, then
 *   starts one.
 * - `urgent` (failure or cancellation): `delivery: 'steer'`, which joins the
 *   active turn at the next step, or starts one when idle.
 */
export function syntheticDelivery(mode: InjectMode): SyntheticDelivery {
  switch (mode) {
    case 'silent':
      return { resume: false }
    case 'final':
      return { delivery: 'queue' }
    case 'urgent':
      return { delivery: 'steer' }
  }
}

type V1Tool = CopilotTools[keyof CopilotTools]

/**
 * Run a V1-shaped tool under a V2 call. V2's context has no directory, so the
 * workspace directory bound at `setup` stands in. `signal` is forwarded as
 * V1's `abort`. Reading it opts the call into V2's cooperative stop, but no
 * tool consumes `abort` today: every tool returns promptly (delegations run
 * in the background), so a user stop just lets the call finish.
 */
async function runTool(
  tool: V1Tool,
  input: unknown,
  context: ToolContext,
  directory: string,
): Promise<{ content: string }> {
  const abort = context.signal
  const v1Context: V1ToolContext = {
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory,
    worktree: directory,
    abort,
    metadata: () => {},
    ask: async () => {},
  }
  const result = await (
    tool.execute as (
      args: unknown,
      ctx: V1ToolContext,
    ) => ReturnType<V1Tool['execute']>
  )(input, v1Context)
  return { content: typeof result === 'string' ? result : result.output }
}

/**
 * OpenCode V2 entry (`setup`), called once per location per activation.
 *
 * Returns early on V1's reduced bridge, which has no location or session.
 * Otherwise it acquires the process core, registers the four tools for the
 * location's directory, and returns a cleanup that stops this activation's
 * notifications and releases the core. The last release cancels running
 * tasks, closes RPC, and truncates the PID ledger.
 */
export async function setupV2(
  context: Plugin.Context,
): Promise<Plugin.Cleanup | undefined> {
  const directory = context?.location?.directory
  if (!directory || !context.session || !context.tool) return undefined

  const resources = await acquireProcessCore(() =>
    initializeProcess({ log: stderrLog }),
  )

  // Notices for this activation stop at cleanup: a task cancelled by the
  // release must not inject into a session served by the next activation.
  let active = true
  const client: NotifyClient = {
    inject: async ({ sessionID, text, mode }) => {
      if (!active) return
      await context.session.synthetic({
        sessionID,
        text,
        ...syntheticDelivery(mode),
      })
    },
    session: {
      prompt: async () => {
        throw new Error('session.prompt is not used on OpenCode V2')
      },
    },
    app: {
      log: async ({ body }) => {
        stderrLog(body.level === 'warn' ? 'warn' : 'info', body.message)
      },
    },
  }

  // Anything that throws between acquire and returning the cleanup must
  // release the reference, or the core can never reach zero and tear down.
  let tools: CopilotTools
  try {
    tools = buildTools({
      client,
      directory,
      pidFilePath: resources.pidFilePath,
      normalizeArgs: false,
    })
  } catch (error) {
    stderrLog('warn', `tool setup failed: ${error}`)
    await releaseProcessCore()
    return undefined
  }
  const names = Object.keys(tools)

  let registration: { dispose: () => Promise<void> } | undefined
  try {
    registration = await context.tool.transform((editor) => {
      for (const [name, tool] of Object.entries(tools)) {
        editor.add({
          name,
          description: tool.description,
          // zod >= 4.2 is a Standard Schema with JSON Schema conversion, so
          // V2 validates input with the plugin's own zod.
          input: z.object(tool.args),
          execute: (input, toolContext) =>
            runTool(tool, input, toolContext, directory),
        })
      }
    })
    // `tools.add` skips a tool whose schema fails to convert without
    // throwing, so check that every tool actually registered.
    await context.tool.reload()
    const listed = new Set((await context.tool.list()).map((tool) => tool.id))
    const missing = names.filter((name) => !listed.has(name))
    if (missing.length > 0) {
      stderrLog('warn', `tools failed to register: ${missing.join(', ')}`)
    }
  } catch (error) {
    stderrLog('warn', `tool registration failed: ${error}`)
  }

  // Idempotent per activation: a second call must not drop another
  // location's reference and tear the shared core down under it.
  let released = false
  return async () => {
    if (released) return
    released = true
    active = false
    await registration?.dispose().catch(() => {})
    await releaseProcessCore()
  }
}
