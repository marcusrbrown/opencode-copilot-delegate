import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { discoverAgents } from './discovery/agents'
import { buildDescription } from './discovery/description'
import { killProcessTree } from './lib/kill-tree'
import { normalizeToolArgSchemas } from './lib/normalize-tool-arg-schemas'
import { getPidIdentity, reapOrphans } from './runtime/orphan-reaper'
import {
  assertOrphansDirNotSymlink,
  assertPluginStateDirNotSymlink,
  resolveInstancePidFilePath,
} from './runtime/pid-file'
import { plugInOnce } from './runtime/plugin-singleton'
import { createCancelTool } from './tools/cancel'
import { createDelegateTool } from './tools/delegate'
import { createOutputTool } from './tools/output'

function getAgentsDirectories(directory: string): {
  userAgentsDir: string
  repoAgentsDir: string
} {
  return {
    userAgentsDir: `${process.env.HOME ?? ''}/.copilot/agents`,
    repoAgentsDir: `${directory}/.github/agents`,
  }
}

async function initializePlugin({ client, directory }: PluginInput) {
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
    },
  }
}

const CopilotDelegate: Plugin = async (input) =>
  plugInOnce({
    doInit: () => initializePlugin(input),
    onDuplicate: (pid) => {
      const message = `[copilot-delegate] duplicate factory invocation in same process (pid=${pid}); reusing existing hooks. Multiple opencode.json sources may list this plugin.`
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

export default CopilotDelegate
