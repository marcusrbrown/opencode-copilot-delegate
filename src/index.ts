import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Plugin } from '@opencode-ai/plugin'
import { discoverAgents } from './discovery/agents'
import { buildDescription } from './discovery/description'
import { killProcessTree } from './lib/kill-tree'
import {
  getPidComm,
  getPidStartTime,
  reapOrphans,
} from './runtime/orphan-reaper'
import { resolveInstancePidFilePath } from './runtime/pid-file'
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

const CopilotDelegate: Plugin = async ({ client, directory }) => {
  const agents = discoverAgents(getAgentsDirectories(directory))
  const delegateDescription = buildDescription(agents)

  const currentInstancePath = resolveInstancePidFilePath()
  const pidFileDir = dirname(currentInstancePath)
  await mkdir(pidFileDir, { recursive: true, mode: 0o700 })
  try {
    await reapOrphans({
      pidFileDir,
      currentInstancePath,
      killProcessTree,
      getPidComm,
      getPidStartTime,
    })
  } catch {
    // Reap failure must not block plugin init.
  }

  return {
    tool: {
      copilot_delegate: createDelegateTool({
        client,
        description: delegateDescription,
        directory,
        pidFilePath: currentInstancePath,
      }),
      copilot_output: createOutputTool(),
      copilot_cancel: createCancelTool(),
    },
  }
}

export default CopilotDelegate
