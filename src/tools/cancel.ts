import { tool } from '@opencode-ai/plugin/tool'
import { cancelTaskById } from '../runtime/cancel-helper'
import { getTask } from '../runtime/task-registry'

const TOOL_DESCRIPTION = [
  'Cancel a running Copilot delegation.',
  '',
  'Aborts the in-flight subprocess via its `AbortController`; the subprocess receives SIGTERM through',
  'its process tree and the task transitions to `cancelled`. Any pending `copilot_output` block calls',
  'unblock immediately with the cancelled envelope.',
  '',
  'Returns `{ cancelled, was_running }`:',
  '- `cancelled: true, was_running: true`  — task was running and the abort signal was sent.',
  '- `cancelled: false, was_running: false` — task is unknown to this process, or already terminal',
  '  (`succeeded` / `failed` / `cancelled`). Idempotent — safe to call multiple times.',
  '',
  'Use when:',
  "- The user changes direction during a long-running delegation and the task's output is no longer needed.",
  '- The agent has determined a delegation has gone wrong (e.g., wrong agent selected) and a fresh delegate is preferable to waiting.',
  '- Concurrency limit pressure — cancel a stale low-priority task to free a slot for a higher-priority delegation.',
].join('\n')

export function createCancelTool() {
  return tool({
    description: TOOL_DESCRIPTION,
    args: {
      task_id: tool.schema
        .string()
        .describe(
          'The task ID returned by `copilot_delegate(...)`. Format: `cpl_<...>`. Required. Idempotent — non-running task IDs return `{ cancelled: false, was_running: false }` without error.',
        ),
    },
    async execute(args) {
      const result = cancelTaskById(
        {
          getTask: (taskId) => {
            const task = getTask(taskId)
            return task?.status === 'running' ? task : undefined
          },
        },
        args.task_id,
      )

      return JSON.stringify({
        cancelled: result.cancelled,
        was_running: result.cancelled,
      })
    },
  })
}
