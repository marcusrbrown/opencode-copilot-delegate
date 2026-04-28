import type { PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import type { NotifyClient } from '../runtime/notify'
import { incrementInFlight, notifyCompletion } from '../runtime/notify'
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

export function createDelegateTool(options: DelegateToolOptions) {
  return tool({
    description:
      'Delegate a task to GitHub Copilot CLI as a background subprocess.\n' +
      'Returns a task_id immediately; parent agent continues other work.\n' +
      'When Copilot completes, a system-reminder is injected into this session.\n' +
      'Retrieve the structured result with `copilot_output(task_id)`.\n\n' +
      options.description,
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
    async execute(args, ctx) {
      const runningCount = getAllTasks().filter(
        (task) => task.status === 'running',
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
