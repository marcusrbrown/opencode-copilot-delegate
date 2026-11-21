import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'

import { discoverAgents } from './discovery/agents'
import { buildDescription } from './discovery/description'
import { killProcessTree } from './lib/kill-tree'
import { normalizeToolArgSchemas } from './lib/normalize-tool-arg-schemas'
import { wireRpcServerCleanup } from './lib/rpc-cleanup'
import { cancelTaskById } from './runtime/cancel-helper'
import { getPidIdentity, reapOrphans } from './runtime/orphan-reaper'
import {
  assertOrphansDirNotSymlink,
  assertPluginStateDirNotSymlink,
  resolveInstancePidFilePath,
} from './runtime/pid-file'
import { initProcessOnce, plugInOnce } from './runtime/plugin-singleton'
import { startRpcServer } from './runtime/rpc-server'
import { getAllTasks, getTask } from './runtime/task-registry'
import { createCancelTool } from './tools/cancel'
import { createDelegateTool } from './tools/delegate'
import { createOutputTool } from './tools/output'
import { createResumeTool } from './tools/resume'

type PluginInputWithTestHooks = PluginInput & {
  __captureRpcCleanup?: (cleanup: () => Promise<void>) => void
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

function logBestEffort(
  client: PluginInput['client'],
  level: 'info' | 'warn',
  message: string,
): void {
  try {
    client.app
      .log({ body: { service: 'copilot-delegate', level, message } })
      .catch(() => {})
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Process-wide setup: orphan reaping, then the RPC server for the TUI. Runs
 * once per process however many workspaces or config sources load the plugin
 * (see `initProcessOnce`). It never rejects, so a failure here can't block
 * tool registration for any workspace.
 */
async function initializeProcess(
  input: PluginInputWithTestHooks,
): Promise<{ pidFilePath: string }> {
  const { client } = input
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
  // must still register its existing tools. The registry is process-wide, so
  // this one server lists and cancels tasks from every workspace.
  try {
    const rpcServer = await startRpcServer({
      taskRegistry: { getAllTasks },
      cancelTaskById: (taskId) => cancelTaskById({ getTask }, taskId),
      log: (message) => logBestEffort(client, 'info', message),
    })
    const closeRpcServer = wireRpcServerCleanup(rpcServer.close)
    input.__captureRpcCleanup?.(closeRpcServer)
  } catch (error) {
    const message = `[copilot-delegate] failed to start RPC server: ${error}`
    console.warn(message)
    logBestEffort(client, 'warn', message)
  }

  return { pidFilePath: currentInstancePath }
}

/** Per-workspace hooks: the four tools, bound to this input's directory. */
function buildHooks(input: PluginInput, pidFilePath: string) {
  const { client, directory } = input
  const agents = discoverAgents(getAgentsDirectories(directory))
  const delegateDescription = buildDescription(agents)

  return {
    tool: {
      copilot_delegate: normalizeToolArgSchemas(
        createDelegateTool({
          client,
          description: delegateDescription,
          directory,
          pidFilePath,
        }),
      ),
      copilot_output: normalizeToolArgSchemas(createOutputTool()),
      copilot_cancel: normalizeToolArgSchemas(createCancelTool()),
      copilot_resume: normalizeToolArgSchemas(
        createResumeTool({ client, directory, pidFilePath }),
      ),
    },
  }
}

const CopilotDelegate: Plugin = async (input) => {
  const { pidFilePath } = await initProcessOnce(() => initializeProcess(input))
  const result = await plugInOnce({
    key: input.directory,
    doInit: async () => buildHooks(input, pidFilePath),
    onDuplicate: (pid) => {
      const message = `[copilot-delegate] duplicate factory invocation for ${input.directory} in the same process (pid=${pid}); returning empty hooks so the host does not double-register tools. Multiple opencode.json sources may list this plugin.`
      console.warn(message)
      // Fire-and-forget so the log call never blocks plugin init.
      logBestEffort(input.client, 'warn', message)
    },
  })
  // Return the envelope's hooks. On the first invocation for a directory
  // this is the real hooks object built by `buildHooks`. On duplicate
  // invocations for the same directory it is `{}`, so the host registers
  // nothing for the duplicate source; see plugin-singleton.ts for the
  // empirical justification.
  return result.hooks
}

export default CopilotDelegate
