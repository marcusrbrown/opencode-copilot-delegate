import type { Plugin } from '@opencode-ai/plugin'
import { discoverAgents } from './discovery/agents'
import { buildDescription } from './discovery/description'
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
  const lifecycle = { isShuttingDown: false }

  return {
    tool: {
      copilot_delegate: createDelegateTool({
        client,
        description: delegateDescription,
        directory,
        isShuttingDown: () => lifecycle.isShuttingDown,
      }),
      copilot_output: createOutputTool(),
      copilot_cancel: createCancelTool(),
    },
  }
}

export default CopilotDelegate
