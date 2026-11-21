import type { PluginInput } from '@opencode-ai/plugin'
import { initializeProcess, type LogSink } from '../core/process'
import { buildTools } from '../core/tools'
import type { NotifyClient } from '../runtime/notify'
import { plugInOnce } from '../runtime/plugin-singleton'
import { acquireProcessCore } from '../runtime/process-core'

type PluginInputWithTestHooks = PluginInput & {
  __captureRpcCleanup?: (cleanup: () => Promise<void>) => void
}

function v1Log(client: PluginInput['client']): LogSink {
  return (level, message) => {
    try {
      client.app
        .log({ body: { service: 'copilot-delegate', level, message } })
        .catch(() => {})
    } catch {
      // Logging is best-effort.
    }
  }
}

/**
 * OpenCode V1 entry (`server`). Process resources are acquired on every call
 * and never released: V1 has no dispose hook, so they live for the process
 * and close on exit signals. Hooks are built once per workspace directory;
 * repeat calls for the same directory (duplicate config sources) get `{}`.
 */
export async function serverV1(input: PluginInputWithTestHooks) {
  const log = v1Log(input.client)
  const { pidFilePath } = await acquireProcessCore(() =>
    initializeProcess({ log, onRpcCleanup: input.__captureRpcCleanup }),
  )
  const result = await plugInOnce({
    key: input.directory,
    doInit: async () => ({
      tool: buildTools({
        client: input.client as NotifyClient,
        directory: input.directory,
        pidFilePath,
        normalizeArgs: true,
      }),
    }),
    onDuplicate: (pid) => {
      const message = `[copilot-delegate] duplicate factory invocation for ${input.directory} in the same process (pid=${pid}); returning empty hooks so the host does not double-register tools. Multiple opencode.json sources may list this plugin.`
      console.warn(message)
      // Fire-and-forget so the log call never blocks plugin init.
      log('warn', message)
    },
  })
  // On the first invocation for a directory this is the real hooks object.
  // On duplicate invocations for the same directory it is `{}`, so the host
  // registers nothing for the duplicate source; see plugin-singleton.ts.
  return result.hooks
}
