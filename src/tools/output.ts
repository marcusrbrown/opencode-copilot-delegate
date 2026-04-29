import { tool } from '@opencode-ai/plugin/tool'
import { buildEnvelope } from '../runtime/envelope'
import { getTask } from '../runtime/task-registry'

const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 120000

function isValidTaskId(taskId: string): boolean {
  return taskId.length > 0 && taskId.startsWith('cpl_')
}

const TOOL_DESCRIPTION = [
  'Retrieve the structured result envelope for a delegated Copilot task.',
  '',
  'Most calls happen after a `copilot_delegate(...)` task triggers its completion `system-reminder`',
  'in this session. The envelope contains everything the agent needs to act on the result:',
  '',
  '- `task_id`, `status` (`running` | `succeeded` | `failed` | `cancelled` | `unknown`)',
  '- `exit_code`, `duration_ms`, `started_at`, `ended_at`',
  '- `agent_name`, `model_name`, `args` (the original CLI args)',
  "- `final_message`: the assistant's last user-visible response, or null",
  '- `error_text`: stderr tail when the subprocess failed',
  '- `summary`: counts of tool calls, files changed, and tokens consumed',
  '- `events` (when present): the sequence of parsed JSONL events from Copilot',
  '',
  'When to call:',
  '- After receiving a completion `system-reminder` for a known `task_id`.',
  '- On demand if the agent needs to inspect a still-running task — pass `block: true` to wait briefly for completion.',
  '- On task IDs the parent agent saved earlier in the session.',
  '',
  'Block mode (`block: true`):',
  '- If the task is still running, wait up to `timeout_ms` (default 30000, capped at 120000) for completion.',
  '- On timeout, returns the envelope with `timed_out: true` and the agent should call again later.',
  '- For research-style delegations that may exceed 120s, prefer non-blocking polling — call this tool again after each `system-reminder` instead of holding open a single long block.',
  '',
  'Unknown task IDs return `{ task_id, status: "unknown", error }` rather than throwing.',
].join('\n')

export function createOutputTool() {
  return tool({
    description: TOOL_DESCRIPTION,
    args: {
      task_id: tool.schema
        .string()
        .describe(
          'The task ID returned by `copilot_delegate(...)`. Format: `cpl_<...>`. Required.',
        ),
      block: tool.schema
        .boolean()
        .describe(
          'If the task is still running, wait for completion up to `timeout_ms` before returning. Default `false` — returns immediately with the current state. Set to `true` only when the agent has nothing else to do but wait.',
        )
        .optional(),
      timeout_ms: tool.schema
        .number()
        .int()
        .min(0)
        .max(MAX_TIMEOUT_MS)
        .describe(
          'Maximum wait in milliseconds when `block` is `true`. Default 30000. Range 0–120000 (the upper cap protects the OpenCode session from a single hung delegation). For long research tasks, prefer multiple non-blocking calls over a long block.',
        )
        .optional(),
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
        const timeoutMs = Math.max(
          0,
          Math.min(args.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
        )
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
