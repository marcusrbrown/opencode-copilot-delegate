import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

const CopilotDelegate: Plugin = async (_input) => {
  return {
    tool: {
      copilot_delegate: tool({
        description:
          'Delegate a task to GitHub Copilot CLI as a background subprocess.\n' +
          'Returns a task_id immediately; parent agent continues other work.\n' +
          'When Copilot completes, a system-reminder is injected into this session.\n' +
          'Retrieve the structured result with `copilot_output(task_id)`.',
        args: {
          prompt: tool.schema
            .string()
            .min(1)
            .describe('The prompt to send to Copilot CLI.'),
          agent: tool.schema
            .string()
            .optional()
            .describe('Copilot agent name. Omit for default.'),
          model: tool.schema
            .string()
            .optional()
            .describe('Model override. Omit for default.'),
          add_dir: tool.schema
            .string()
            .array()
            .optional()
            .describe('Additional directories to allow.'),
          allow_tool: tool.schema
            .string()
            .array()
            .optional()
            .describe('Tool patterns to allow.'),
          deny_tool: tool.schema
            .string()
            .array()
            .optional()
            .describe('Tool patterns to deny.'),
        },
        async execute(_args, _ctx) {
          // TODO: implement in T6
          throw new Error('copilot_delegate not yet implemented')
        },
      }),

      copilot_output: tool({
        description:
          'Retrieve the structured result envelope for a delegated Copilot task.',
        args: {
          task_id: tool.schema
            .string()
            .describe('Task ID returned by copilot_delegate.'),
          block: tool.schema
            .boolean()
            .optional()
            .describe('Wait for completion. Default false.'),
          timeout_ms: tool.schema
            .number()
            .max(120000)
            .optional()
            .describe('Max wait ms when block is true. Default 30000.'),
        },
        async execute(_args, _ctx) {
          // TODO: implement in T6
          throw new Error('copilot_output not yet implemented')
        },
      }),

      copilot_cancel: tool({
        description: 'Cancel a running Copilot delegation.',
        args: {
          task_id: tool.schema
            .string()
            .describe('Task ID returned by copilot_delegate.'),
        },
        async execute(_args, _ctx) {
          // TODO: implement in T6
          throw new Error('copilot_cancel not yet implemented')
        },
      }),
    },
  }
}

export default CopilotDelegate
