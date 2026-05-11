/**
 * copilot_resume tool — resumes a prior Copilot session by ID, name, or prefix.
 *
 * Wraps `copilot --resume=<targetId>` with:
 *   - Input validation (validateTargetId, validateAddDirs, validateCwd)
 *   - UUID preflight: checks local session.db before spawning
 *   - Known-task addDirs reuse: if a prior task's copilotSessionId matches targetId,
 *     its captured addDirs are reused when the caller omits addDirs
 *   - CLI no-match stderr normalization to structured { error } response
 *   - origin: 'resume' on the created TaskState
 *   - Full completion pipeline (attachCompletionPipeline) identical to delegate
 *
 * No `prompt` argument — resume + new prompt is a fork operation.
 *
 * Exports `launchResume` for RPC reuse.
 */

import type { PluginInput } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'
import {
  hasLocalCopilotSession,
  normalizeContinuityError,
  resolveConfigDir,
} from '../runtime/continuity-checks'
import {
  validateAddDirs,
  validateCwd,
  validateTargetId,
} from '../runtime/continuity-validation'
import type { NotifyClient } from '../runtime/notify'
import {
  attachCompletionPipeline,
  incrementInFlight,
  notifySpawn,
} from '../runtime/notify'
import type { SpawnCopilotResult } from '../runtime/subprocess'
import { spawnCopilot } from '../runtime/subprocess'
import { createTask, deleteTask, getAllTasks } from '../runtime/task-registry'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function appendRepeatedFlag(
  args: string[],
  flag: string,
  values?: string[],
): void {
  for (const value of values ?? []) {
    args.push(flag, value)
  }
}

/**
 * Compute allowed roots for path validation.
 * Only the plugin `directory` option is an allowed root.
 */
function computeAllowedRoots(directory: string): string[] {
  return [directory]
}

// ---------------------------------------------------------------------------
// launchResume — exported for RPC reuse
// ---------------------------------------------------------------------------

export type LaunchResumeOptions = {
  client: PluginInput['client']
  directory: string
  sessionID: string
  targetId: string
  cwd?: string
  addDirs?: string[]
  configDir?: string
  pidFilePath?: string
}

export type LaunchResumeResult = { task_id: string } | { error: string }

type ValidatedResumeInputs = {
  targetValue: string
  targetType: 'uuid' | 'name'
  resolvedAddDirs: string[] | undefined
  resolvedCwd: string | undefined
  cliArgs: string[]
}

/**
 * Validate targetId and run UUID preflight if needed.
 */
async function validateTarget(
  targetId: string,
  configDir?: string,
): Promise<{ type: 'uuid' | 'name'; value: string } | { error: string }> {
  const targetResult = validateTargetId(targetId)
  if ('error' in targetResult) return targetResult

  if (targetResult.type === 'uuid') {
    const resolvedConfigDir = resolveConfigDir(configDir)
    const hasSession = await hasLocalCopilotSession(
      targetResult.value,
      resolvedConfigDir,
    )
    if (!hasSession) {
      return { error: `No local session found for UUID ${targetResult.value}` }
    }
  }

  return targetResult
}

/**
 * Validate addDirs and cwd against allowed roots.
 */
function validatePaths(
  opts: Pick<LaunchResumeOptions, 'addDirs' | 'cwd'>,
  inheritedAddDirs: string[] | undefined,
  allowedRoots: string[],
):
  | { resolvedAddDirs: string[] | undefined; resolvedCwd: string | undefined }
  | { error: string } {
  let resolvedAddDirs = opts.addDirs ?? inheritedAddDirs

  if (resolvedAddDirs && resolvedAddDirs.length > 0) {
    const addDirsResult = validateAddDirs(resolvedAddDirs, allowedRoots)
    if (!Array.isArray(addDirsResult)) return { error: addDirsResult.error }
    resolvedAddDirs = addDirsResult
  }

  let resolvedCwd: string | undefined
  if (opts.cwd) {
    const cwdResult = validateCwd(opts.cwd, allowedRoots)
    if (typeof cwdResult !== 'string') return { error: cwdResult.error }
    resolvedCwd = cwdResult
  }

  return { resolvedAddDirs, resolvedCwd }
}

/**
 * Validate all inputs for a resume operation and assemble the argv.
 * Returns either a structured error or the validated inputs ready for spawn.
 */
async function validateResumeInputs(
  opts: LaunchResumeOptions,
): Promise<ValidatedResumeInputs | { error: string }> {
  const { directory, targetId, configDir } = opts

  const targetResult = await validateTarget(targetId, configDir)
  if ('error' in targetResult) return targetResult

  // Reuse captured addDirs from a prior task when the caller omits them
  const callerAddDirs = opts.addDirs
  const inheritedAddDirs =
    !callerAddDirs || callerAddDirs.length === 0
      ? getAllTasks().find((t) => t.copilotSessionId === targetId)?.addDirs
      : undefined

  const allowedRoots = computeAllowedRoots(directory)
  const pathsResult = validatePaths(
    { addDirs: callerAddDirs, cwd: opts.cwd },
    inheritedAddDirs,
    allowedRoots,
  )
  if ('error' in pathsResult) return pathsResult

  const cliArgs = [
    `--resume=${targetResult.value}`,
    '--output-format',
    'json',
    '-s',
    '--allow-all-tools',
    '--no-ask-user',
  ]
  appendRepeatedFlag(cliArgs, '--add-dir', pathsResult.resolvedAddDirs)

  return {
    targetValue: targetResult.value,
    targetType: targetResult.type,
    resolvedAddDirs: pathsResult.resolvedAddDirs,
    resolvedCwd: pathsResult.resolvedCwd,
    cliArgs,
  }
}

/** Milliseconds to wait for an immediate CLI failure before attaching the pipeline. */
const NAME_TARGET_FAILURE_WINDOW_MS = 500

function attachResumePipeline(
  client: PluginInput['client'],
  sessionID: string,
  task: ReturnType<typeof createTask>,
  spawnResult: SpawnCopilotResult,
): void {
  incrementInFlight(sessionID)
  void notifySpawn(client as NotifyClient, task.taskId).catch(() => {})
  attachCompletionPipeline(task, spawnResult, client as NotifyClient)
}

export async function launchResume(
  opts: LaunchResumeOptions,
): Promise<LaunchResumeResult> {
  const { client, directory, sessionID, pidFilePath } = opts

  const validated = await validateResumeInputs(opts)
  if ('error' in validated) return validated

  const { targetType, resolvedAddDirs, resolvedCwd, cliArgs } = validated
  const effectiveCwd = resolvedCwd ?? directory

  const startedAt = Date.now()
  let spawnResult: SpawnCopilotResult

  try {
    spawnResult = spawnCopilot(cliArgs, { cwd: effectiveCwd, pidFilePath })
  } catch (error) {
    return {
      error: `Failed to spawn copilot: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const { taskId: spawnTaskId, ...spawnFields } = spawnResult

  const task = createTask(
    {
      ...spawnFields,
      parentSessionID: sessionID,
      startedAt,
      args: cliArgs,
      cwd: effectiveCwd,
      origin: 'resume',
      addDirs: resolvedAddDirs,
      pidFilePath,
    },
    spawnTaskId,
  )

  if (targetType === 'uuid') {
    attachResumePipeline(client, sessionID, task, spawnResult)
    return { task_id: task.taskId }
  }

  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), NAME_TARGET_FAILURE_WINDOW_MS),
  )

  const raceResult = await Promise.race([
    spawnResult.completionPromise.then(() => 'done' as const),
    timeout,
  ])

  if (raceResult !== 'timeout') {
    const noMatch =
      spawnResult.errorText &&
      normalizeContinuityError(spawnResult.errorText) !== null
    if (noMatch) {
      deleteTask(task.taskId)
      return { error: `Session not found: '${opts.targetId}'` }
    }
  }

  attachResumePipeline(client, sessionID, task, spawnResult)
  return { task_id: task.taskId }
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

type ResumeToolOptions = {
  client: PluginInput['client']
  directory: string
  pidFilePath?: string
}

const TOOL_DESCRIPTION = [
  'Resume a prior Copilot session by ID, name, or prefix.',
  '',
  'Wraps `copilot --resume=<targetId>` and returns a plugin task handle immediately.',
  'The resumed session runs as a background subprocess; retrieve its output with',
  '`copilot_output(task_id)` and cancel it with `copilot_cancel(task_id)`.',
  '',
  'Target formats:',
  '- UUID (e.g. `123e4567-e89b-12d3-a456-426614174000`) — validated against the',
  '  local Copilot session store before spawning.',
  '- Session name or prefix — passed directly to the CLI.',
  '- Plugin task ID (`cpl_*`) — not supported here; use `copilot_output` instead.',
  '',
  'Note: resume + new prompt is a fork operation and is not part of this release.',
  'This tool resumes the session as-is without injecting a new prompt.',
].join('\n')

export function createResumeTool(options: ResumeToolOptions) {
  return tool({
    description: TOOL_DESCRIPTION,
    args: {
      targetId: tool.schema
        .string()
        .min(1)
        .describe(
          'Session identity to resume. Accepts a Copilot session UUID, a session name, or a unique name prefix. UUID targets are validated against the local session store before spawning.',
        ),
      cwd: tool.schema
        .string()
        .optional()
        .describe(
          'Working directory for the resumed session. Must be an absolute path within the active workspace. Defaults to the plugin directory when omitted.',
        ),
      addDirs: tool.schema
        .string()
        .array()
        .optional()
        .describe(
          'Additional repository paths to grant Copilot access to. Each entry becomes a `--add-dir <path>` flag. When omitted and a prior plugin task matches the target, its captured addDirs are reused automatically.',
        ),
      configDir: tool.schema
        .string()
        .optional()
        .describe(
          'Override the Copilot config directory used for UUID session-state lookup. Defaults to `~/.copilot` (or `COPILOT_CONFIG_DIR` env). Rarely needed.',
        ),
    },
    async execute(args, ctx) {
      const result = await launchResume({
        client: options.client,
        directory: options.directory,
        pidFilePath: options.pidFilePath,
        sessionID: ctx.sessionID,
        targetId: args.targetId,
        cwd: args.cwd,
        addDirs: args.addDirs,
        configDir: args.configDir,
      })

      return JSON.stringify(result)
    },
  })
}
