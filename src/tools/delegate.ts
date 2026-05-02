import type { PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import type { NotifyClient } from '../runtime/notify'
import {
  incrementInFlight,
  notifyCompletion,
  notifySpawn,
} from '../runtime/notify'
import type { SpawnCopilotResult } from '../runtime/subprocess'
import { spawnCopilot } from '../runtime/subprocess'
import type { TaskState } from '../runtime/task-registry'
import { createTask, getAllTasks } from '../runtime/task-registry'

const MAX_CONCURRENT = 10

type DelegateToolOptions = {
  client: PluginInput['client']
  description: string
  directory: string
  pidFilePath?: string
}

function appendRepeatedFlag(
  args: string[],
  flag: string,
  values?: string[],
): void {
  for (const value of values ?? []) {
    args.push(flag, value)
  }
}

const TOOL_DESCRIPTION = [
  'Delegate a task to GitHub Copilot CLI as a background subprocess.',
  '',
  'Returns a `task_id` immediately so the parent agent can continue other work in parallel.',
  'When Copilot completes, a `system-reminder` is injected into this OpenCode session and the',
  'agent retrieves the structured result with `copilot_output(task_id)`.',
  '',
  'Use for:',
  '- Long-running research, implementation, or multi-step automation that would otherwise stall the parent session.',
  '- Running multiple Copilot calls in parallel (subject to a 10-call concurrency cap, enforced here).',
  '- Isolating Copilot tool permissions per-task via `allow_tool` / `deny_tool`.',
  '',
  'Do not use for:',
  '- Short single-turn prompts the parent session can answer directly.',
  '- Tasks where the prompt would contain secrets — Copilot CLI exposes prompts in `ps` output (upstream limitation).',
  '',
  'Lifecycle:',
  '1. `copilot_delegate(...)` → returns `{ task_id }`. The subprocess starts immediately.',
  '2. Continue with other work; do not poll `copilot_output` while the task is running.',
  '3. When the task ends (success, error, or cancellation) a `system-reminder` arrives in this session.',
  '4. `copilot_output(task_id)` returns the structured envelope (status, exit_code, final_message, summary, events, ...).',
  '5. `copilot_cancel(task_id)` aborts a running task at any time.',
  '',
  'Concurrency: at most 10 Copilot delegations may be running concurrently per OpenCode session. Exceeding the cap returns `{ error: ... }` and the agent should wait for an in-flight task to complete or cancel.',
  '',
  'Agent argument: `--agent <name>` must resolve to a discovered `<name>.md` file in `~/.copilot/agents` (user-level) or `.github/agents` (repo-level). An unrecognized name is rejected by Copilot CLI at spawn time.',
  '',
].join('\n')

export function createDelegateTool(options: DelegateToolOptions) {
  return tool({
    description: `${TOOL_DESCRIPTION}${options.description}`,
    args: {
      prompt: tool.schema
        .string()
        .min(1)
        .describe(
          'The instruction Copilot should execute. The prompt body is the entire user-visible task; Copilot owns the planning, tool selection, and execution. Required and must be non-empty. Visible in `ps` output (upstream limitation) — never include secrets, tokens, or PII.',
        ),
      agent: tool.schema
        .string()
        .optional()
        .describe(
          'Agent name (without .md extension) to use for this task. Must match a discovered agent file in `~/.copilot/agents` or `.github/agents`. The list of currently discovered agents appears at the bottom of this tool description; an empty list means no agents are discoverable and `agent` must be omitted. Omit to use the Copilot CLI default.',
        ),
      model: tool.schema
        .string()
        .optional()
        .describe(
          "Override the default model for this task. Accepts any model string Copilot CLI recognizes — for example `claude-opus-4.7`, `claude-sonnet-4.7`, or `gpt-5`. Omit to use the user's configured default.",
        ),
      add_dir: tool.schema
        .string()
        .array()
        .optional()
        .describe(
          'Additional repository paths to grant Copilot access to (multi-repo workflows). Each entry becomes a `--add-dir <path>` flag. Use absolute paths. Examples: `["/Users/me/repo-a", "/Users/me/repo-b"]`.',
        ),
      allow_tool: tool.schema
        .string()
        .array()
        .optional()
        .describe(
          'Copilot tool patterns to allow during this task. Each entry becomes an `--allow-tool <pattern>` flag. Examples: `"shell(*)"`, `"edit"`, `"fetch"`. See the Copilot CLI docs for the full pattern syntax. Layered with `deny_tool` when both are present.',
        ),
      deny_tool: tool.schema
        .string()
        .array()
        .optional()
        .describe(
          'Copilot tool patterns to deny during this task. Each entry becomes a `--deny-tool <pattern>` flag. Examples: `"shell(rm)"`, `"shell(curl)"`. Use to harden a task by blocking dangerous operations even if `allow_tool` would permit them.',
        ),
    },
    async execute(args, ctx) {
      const runningCount = getAllTasks().filter(
        (task) => task.status === 'running' || task.status === 'cancelling',
      ).length

      if (runningCount >= MAX_CONCURRENT) {
        return JSON.stringify({
          error:
            'Concurrent delegation limit reached (10 running). Cancel or wait for existing tasks.',
        })
      }

      const cliArgs = [
        '-p',
        args.prompt,
        '--output-format',
        'json',
        '-s',
        '--allow-all-tools',
        '--no-ask-user',
      ]

      if (args.agent) {
        cliArgs.push('--agent', args.agent)
      }

      if (args.model) {
        cliArgs.push('--model', args.model)
      }

      appendRepeatedFlag(cliArgs, '--add-dir', args.add_dir)
      appendRepeatedFlag(cliArgs, '--allow-tool', args.allow_tool)
      appendRepeatedFlag(cliArgs, '--deny-tool', args.deny_tool)

      const startedAt = Date.now()
      let spawnResult: SpawnCopilotResult
      let task: TaskState

      try {
        spawnResult = spawnCopilot(cliArgs, {
          cwd: options.directory,
          pidFilePath: options.pidFilePath,
        })
        const { taskId: spawnTaskId, ...spawnFields } = spawnResult

        task = createTask(
          {
            ...spawnFields,
            parentSessionID: ctx.sessionID,
            startedAt,
            args: cliArgs,
            cwd: options.directory,
            agentName: args.agent,
            modelName: args.model,
            pidFilePath: options.pidFilePath,
          },
          spawnTaskId,
        )
      } catch (error) {
        return JSON.stringify({
          error: `Failed to spawn copilot: ${error instanceof Error ? error.message : String(error)}`,
        })
      }

      incrementInFlight(ctx.sessionID)
      void notifySpawn(options.client as NotifyClient, task.taskId).catch(
        () => {
          // Spawn-toast failures are non-fatal for the tool call.
        },
      )

      void task.completionPromise
        .then(async () => {
          Object.assign(task, {
            status: spawnResult.status,
            exitCode: spawnResult.exitCode,
            endedAt: spawnResult.endedAt,
            stdoutLineBuffer: spawnResult.stdoutLineBuffer,
            finalMessage: spawnResult.finalMessage,
            errorText: spawnResult.errorText,
          })

          try {
            await notifyCompletion(options.client as NotifyClient, {
              taskId: task.taskId,
              parentSessionID: task.parentSessionID,
              status: task.status,
              agentName: task.agentName,
              modelName: task.modelName,
              startedAt: task.startedAt,
              exitCode: task.exitCode,
            })
          } catch {
            // Notification failures are non-fatal for the tool call.
          }
        })
        .catch(() => {
          // completionPromise should resolve, but ignore unexpected rejections
        })

      return JSON.stringify({ task_id: task.taskId })
    },
  })
}
