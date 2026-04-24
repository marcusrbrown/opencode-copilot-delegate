import { tool } from '@opencode-ai/plugin/tool'
import { getTask } from '../runtime/task-registry'

type CancelResult = {
  cancelled: boolean
  was_running: boolean
}

function asToolResult(result: CancelResult): CancelResult & string {
  return result as unknown as CancelResult & string
}

export function createCancelTool() {
  return tool({
    description: 'Cancel a running Copilot delegation.',
    args: {
      task_id: tool.schema
        .string()
        .describe('Task ID returned by copilot_delegate.'),
    },
    async execute(args) {
      const task = getTask(args.task_id)
      if (!task || task.status !== 'running') {
        return asToolResult({ cancelled: false, was_running: false })
      }

      task.abortController.abort()

      return asToolResult({ cancelled: true, was_running: true })
    },
  })
}
