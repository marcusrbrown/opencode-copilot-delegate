import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { discoverAgents } from './discovery/agents'
import { buildDescription } from './discovery/description'
import { killProcessTree } from './lib/kill-tree'
import { normalizeToolArgSchemas } from './lib/normalize-tool-arg-schemas'
import { cancelTaskById } from './runtime/cancel-helper'
import { getPidIdentity, reapOrphans } from './runtime/orphan-reaper'
import {
  assertOrphansDirNotSymlink,
  assertPluginStateDirNotSymlink,
  resolveInstancePidFilePath,
} from './runtime/pid-file'
import { plugInOnce } from './runtime/plugin-singleton'
import { startRpcServer } from './runtime/rpc-server'
import { getAllTasks, getTask } from './runtime/task-registry'
import { createCancelTool } from './tools/cancel'
import { createDelegateTool } from './tools/delegate'
import { createOutputTool } from './tools/output'
import { createResumeTool } from './tools/resume'

type PluginInputWithTestHooks = PluginInput & {
  __captureRpcCleanup?: (cleanup: () => Promise<void>) => void
}

export function wireRpcServerCleanup(
  closeRpcServer: () => Promise<void>,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined

  const closeOnce = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeRpcServer()
        .catch(() => {})
        .finally(() => {
          process.off('beforeExit', onBeforeExit)
          process.off('SIGTERM', onSigterm)
        })
    }

    return closePromise
  }

  const onBeforeExit = () => {
    void closeOnce()
  }

  const onSigterm = () => {
    void closeOnce().finally(() => {
      process.kill(process.pid, 'SIGTERM')
    })
  }

  process.on('beforeExit', onBeforeExit)
  process.once('SIGTERM', onSigterm)

  return closeOnce
}

function getAgentsDirectories(directory: string): {
  userAgentsDir: string
  repoAgentsDir: string
} {
  return {
    userAgentsDir: `${process.env.HOME ?? ''}/.copilot/agents`,
    repoAgentsDir: `${directory}/.github/agents`,
  }
}

async function initializePlugin(input: PluginInputWithTestHooks) {
  const { client, directory } = input
  const agents = discoverAgents(getAgentsDirectories(directory))
  const delegateDescription = buildDescription(agents)

  const currentInstancePath = resolveInstancePidFilePath()
  const pidFileDir = dirname(currentInstancePath)
  try {
    // mkdir is inside the try/catch so plugin init survives read-only
    // filesystems (EROFS) or permission-denied state dirs (EACCES). Both
    // failure modes degrade gracefully: reapOrphans's own readdir guard
    // returns an empty result when the directory cannot be enumerated.
    await assertPluginStateDirNotSymlink(currentInstancePath)
    await mkdir(pidFileDir, { recursive: true, mode: 0o700 })
    await assertOrphansDirNotSymlink(currentInstancePath)
    await reapOrphans({
      pidFileDir,
      currentInstancePath,
      killProcessTree,
      getPidIdentity,
    })
  } catch {
    // mkdir or reap failure must not block plugin init.
  }

  // RPC/TUI status is additive. If localhost startup fails, the server plugin
  // must still register its existing tools.
  try {
    const rpcServer = await startRpcServer({
      taskRegistry: { getAllTasks },
      cancelTaskById: (taskId) => cancelTaskById({ getTask }, taskId),
    })
    const closeRpcServer = wireRpcServerCleanup(rpcServer.close)
    input.__captureRpcCleanup?.(closeRpcServer)
  } catch (error) {
    const message = `[copilot-delegate] failed to start RPC server: ${error}`
    console.warn(message)
    try {
      client.app
        .log({
          body: {
            service: 'copilot-delegate',
            level: 'warn',
            message,
          },
        })
        .catch(() => {})
    } catch {
      // Logging is best-effort; RPC startup failure must not block tools.
    }
  }

  return {
    tool: {
      copilot_delegate: normalizeToolArgSchemas(
        createDelegateTool({
          client,
          description: delegateDescription,
          directory,
          pidFilePath: currentInstancePath,
        }),
      ),
      copilot_output: normalizeToolArgSchemas(createOutputTool()),
      copilot_cancel: normalizeToolArgSchemas(createCancelTool()),
      copilot_resume: normalizeToolArgSchemas(
        createResumeTool({
          client,
          directory,
          pidFilePath: currentInstancePath,
        }),
      ),
    },
  }
}

const CopilotDelegate: Plugin = async (input) => {
  const result = await plugInOnce({
    doInit: () => initializePlugin(input),
    onDuplicate: (pid) => {
      const message = `[copilot-delegate] duplicate factory invocation in same process (pid=${pid}); returning empty hooks so the host does not double-register tools. Multiple opencode.json sources may list this plugin.`
      console.warn(message)
      // Fire-and-forget so the log call never blocks plugin init.
      input.client.app
        .log({
          body: {
            service: 'copilot-delegate',
            level: 'warn',
            message,
          },
        })
        .catch(() => {})
    },
  })
  // Return the envelope's hooks. On the first invocation this is the real
  // hooks object built by `initializePlugin`. On duplicate invocations
  // this is `{}` so the host registers nothing for the duplicate source —
  // see plugin-singleton.ts for the empirical justification.
  return result.hooks
}

export default CopilotDelegate
