import { tool } from '@opencode-ai/plugin/tool'
import { buildEnvelope } from '../runtime/envelope'
import { getTask } from '../runtime/task-registry'

function isValidTaskId(taskId: string): boolean {
  return taskId.length > 0 && taskId.startsWith('cpl_')
}

export function createOutputTool() {
  return tool({
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
    async execute(args) {
      if (!isValidTaskId(args.task_id)) {
        return JSON.stringify({
          task_id: args.task_id,
          status: 'unknown',
          error: 'Invalid task_id format',
        })
      }

      const task = getTask(args.task_id)
      if (!task) {
        return JSON.stringify({
          task_id: args.task_id,
          status: 'unknown',
          error: 'Task not found in this OpenCode process',
        })
      }

      if (args.block && task.status === 'running') {
        const timeoutMs = Math.min(args.timeout_ms ?? 30000, 120000)
        let timer: ReturnType<typeof setTimeout> | undefined
        const completed = await Promise.race([
          task.completionPromise.then(() => {
            clearTimeout(timer)
            return true
          }),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs)
          }),
        ])

        if (!completed) {
          return JSON.stringify(
            buildEnvelope({
              ...task,
              timedOut: true,
            }),
          )
        }
      }

      return JSON.stringify(buildEnvelope(task))
    },
  })
}
