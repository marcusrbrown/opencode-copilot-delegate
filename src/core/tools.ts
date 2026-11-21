import { discoverAgents } from '../discovery/agents'
import { buildDescription } from '../discovery/description'
import { normalizeToolArgSchemas } from '../lib/normalize-tool-arg-schemas'
import type { NotifyClient } from '../runtime/notify'
import { createCancelTool } from '../tools/cancel'
import { createDelegateTool } from '../tools/delegate'
import { createOutputTool } from '../tools/output'
import { createResumeTool } from '../tools/resume'

export interface BuildToolsOptions {
  /** Notification sink for this workspace's completions. */
  client: NotifyClient
  /** Workspace directory the tools are bound to. */
  directory: string
  pidFilePath: string
  /**
   * Patch each arg schema's `toJSONSchema` so descriptions survive the V1
   * host's separate zod copy. V1 only: the patch breaks zod's own
   * whole-object conversion, which V2 uses through Standard Schema, and V2
   * would then skip every tool without an error.
   */
  normalizeArgs: boolean
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

/**
 * The four `copilot_*` tools for one workspace, in the V1 shape
 * (`{ description, args, execute }`, with zod args from the bundled zod).
 * Both host adapters register exactly this set, so the tools can't drift
 * between hosts.
 */
export function buildTools(options: BuildToolsOptions) {
  const { client, directory, pidFilePath } = options
  const agents = discoverAgents(getAgentsDirectories(directory))
  const normalize = <T extends Parameters<typeof normalizeToolArgSchemas>[0]>(
    definition: T,
  ): T =>
    options.normalizeArgs ? normalizeToolArgSchemas(definition) : definition

  return {
    copilot_delegate: normalize(
      createDelegateTool({
        client,
        description: buildDescription(agents),
        directory,
        pidFilePath,
      }),
    ),
    copilot_output: normalize(createOutputTool()),
    copilot_cancel: normalize(createCancelTool()),
    copilot_resume: normalize(
      createResumeTool({ client, directory, pidFilePath }),
    ),
  }
}

export type CopilotTools = ReturnType<typeof buildTools>
