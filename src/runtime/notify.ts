/**
 * Notification injection for Copilot delegation completions.
 *
 * Injects `<system-reminder>` messages into the parent OpenCode session
 * when a delegated Copilot subprocess completes. Uses `noReply` semantics
 * mirroring OMO's per-parent-session in-flight counter pattern.
 *
 * Correctness invariant: decrement the in-flight counter synchronously
 * (before any await) to prevent concurrent completions from both reading
 * the same counter value and both setting noReply: false.
 */

import type { TaskStatus } from './envelope'
import type { SpawnCopilotResult } from './subprocess'
import type { TaskOrigin, TaskState } from './task-registry'

/** Minimal client interface for notification injection. */
export type NotifyClient = {
  session: {
    prompt: (opts: {
      path: { id: string }
      body: {
        noReply: boolean
        parts: Array<{ type: 'text'; text: string; synthetic: boolean }>
      }
    }) => Promise<unknown>
  }
  tui?: {
    showToast: (opts: {
      body: {
        message: string
        variant: 'info' | 'success' | 'warning' | 'error'
      }
    }) => unknown
  }
  app: {
    log: (opts: {
      body: { service: string; level: string; message: string; extra?: unknown }
    }) => Promise<unknown>
  }
}

/** Task information needed for building the notification. */
export type NotifyTaskInfo = {
  taskId: string
  parentSessionID: string
  status: TaskStatus
  agentName?: string
  modelName?: string
  startedAt: number
  exitCode?: number
  /**
   * Source of the task. Optional for back-compat with callers that
   * predate the discriminator (S2 Unit 1); existing call sites and
   * tests omit it and the formatter falls back to the spawn variant.
   */
  origin?: TaskOrigin
}

/** Per-parent-session in-flight task counters. */
const inFlightCounters = new Map<string, number>()

/** Increment the in-flight counter for a parent session. */
export function incrementInFlight(parentSessionID: string): void {
  const current = inFlightCounters.get(parentSessionID) ?? 0
  inFlightCounters.set(parentSessionID, current + 1)
}

/** Decrement the in-flight counter for a parent session. Returns remaining count. */
function decrementInFlight(parentSessionID: string): number {
  const current = inFlightCounters.get(parentSessionID) ?? 0
  const remaining = Math.max(0, current - 1)

  if (remaining === 0) {
    inFlightCounters.delete(parentSessionID)
  } else {
    inFlightCounters.set(parentSessionID, remaining)
  }

  return remaining
}

/** Reset all counters (for testing only). */
export function resetInFlightCounters(): void {
  inFlightCounters.clear()
}

export async function notifySpawn(
  client: NotifyClient,
  taskId: string,
): Promise<void> {
  if (!client.tui) {
    return
  }

  try {
    await client.tui.showToast({
      body: {
        message: `Copilot delegation ${taskId} started`,
        variant: 'info',
      },
    })
  } catch {
    // Toast failure is non-critical
  }
}

/** Format duration in human-readable form. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}m ${remainingSeconds}s`
}

/**
 * Section header for the system-reminder text. Defaults to the spawn
 * header for back-compat with callers that predate the discriminator.
 *
 * Per the High-Level Technical Design table in
 * `docs/plans/2026-05-02-001-feat-copilot-session-continuity-resume-connect-plan.md`:
 *   spawn   → "COPILOT DELEGATION COMPLETED"
 *   resume  → "COPILOT RESUME COMPLETED"
 *   connect → "COPILOT CONNECTOR DISCONNECTED"  (deferred — no connect-origin
 *             tasks are constructed in this slice; included for forward compat)
 */
function notificationHeader(origin: TaskOrigin | undefined): string {
  switch (origin) {
    case 'resume':
      return '[COPILOT RESUME COMPLETED]'
    case 'connect':
      return '[COPILOT CONNECTOR DISCONNECTED]'
    default:
      return '[COPILOT DELEGATION COMPLETED]'
  }
}

/** Build the `<system-reminder>` notification text. */
function buildNotificationText(task: NotifyTaskInfo): string {
  const agent = task.agentName ?? 'default'
  const model = task.modelName ?? 'default'
  const duration = formatDuration(Date.now() - task.startedAt)
  const header = notificationHeader(task.origin)

  let text = `<system-reminder>
${header}
**Task ID:** \`${task.taskId}\`
**Agent:** ${agent}
**Model:** ${model}
**Duration:** ${duration}
**Status:** ${task.status}

Use \`copilot_output(task_id="${task.taskId}")\` to retrieve the structured result.`

  if (task.status === 'failed') {
    text += `\n\n**ACTION REQUIRED:** Subprocess exited with code ${task.exitCode ?? 'unknown'}.`
  }

  text += '\n</system-reminder>'
  return text
}

/**
 * Notify the parent session that a Copilot delegation has completed.
 *
 * Decrements the in-flight counter synchronously, then injects the
 * notification via client.session.prompt with correct noReply semantics.
 * Never throws — logs and swallows prompt/toast errors.
 */
export async function notifyCompletion(
  client: NotifyClient,
  task: NotifyTaskInfo,
): Promise<void> {
  // Decrement synchronously BEFORE any await — correctness invariant
  const remaining = decrementInFlight(task.parentSessionID)

  // Failed exits always force a parent turn
  const noReply: boolean =
    task.status === 'failed' || task.status === 'cancelled'
      ? false
      : remaining > 0

  const text = buildNotificationText(task)

  try {
    await client.session.prompt({
      path: { id: task.parentSessionID },
      body: {
        noReply,
        parts: [{ type: 'text', text, synthetic: true }],
      },
    })
  } catch (error) {
    // Wrap in try/catch as well as .catch() because client.app.log may throw
    // synchronously (e.g., shape validation, dead session binding) before
    // returning a Promise; .catch() alone would let those escape and violate
    // notifyCompletion's "never throws" contract.
    try {
      client.app
        .log({
          body: {
            service: 'copilot-delegate',
            level: 'warn',
            message: `Failed to inject notification for ${task.taskId}: ${error}`,
          },
        })
        .catch(() => {})
    } catch {
      // Swallow synchronous throws from client.app.log
    }
  }

  try {
    const variant = task.status === 'complete' ? 'success' : 'error'
    const toastMessage =
      task.status === 'complete'
        ? `Copilot delegation ${task.taskId} completed`
        : `Copilot delegation ${task.taskId} ${task.status}`

    client.tui?.showToast({
      body: { message: toastMessage, variant },
    })
  } catch {
    // Toast failure is non-critical
  }
}

/**
 * Attach the post-completion pipeline to a task and its underlying spawn
 * result. Encapsulates the back-patch of late-arriving fields from
 * `SpawnCopilotResult` to the registry `TaskState`, then dispatches the
 * completion notification.
 *
 * The back-patch is load-bearing: `task` is created up-front from a
 * snapshot of `spawnFields`, so post-spawn fields populated by the
 * subprocess wrapper (status, finalMessage, copilotSessionId, etc) live
 * on `spawnResult` until they are explicitly synced. Any field assigned
 * after `createTask` returned needs to appear in the assign list —
 * otherwise it is invisible to `copilot_output` even when present on
 * `spawnResult`.
 *
 * Origin-aware notification text is delegated to `buildNotificationText`
 * via `task.origin`, so this helper itself is origin-agnostic — the same
 * pipeline drives spawn-, resume-, and (eventually) connect-origin tasks.
 */
export function attachCompletionPipeline(
  task: TaskState,
  spawnResult: SpawnCopilotResult,
  client: NotifyClient,
): void {
  void task.completionPromise
    .then(async () => {
      Object.assign(task, {
        status: spawnResult.status,
        exitCode: spawnResult.exitCode,
        endedAt: spawnResult.endedAt,
        stdoutLineBuffer: spawnResult.stdoutLineBuffer,
        finalMessage: spawnResult.finalMessage,
        errorText: spawnResult.errorText,
        copilotSessionId: spawnResult.copilotSessionId,
      })

      try {
        await notifyCompletion(client, {
          taskId: task.taskId,
          parentSessionID: task.parentSessionID,
          status: task.status,
          agentName: task.agentName,
          modelName: task.modelName,
          startedAt: task.startedAt,
          exitCode: task.exitCode,
          origin: task.origin,
        })
      } catch {
        // Notification failures are non-fatal for the tool call.
      }
    })
    .catch(() => {
      // completionPromise should resolve, but ignore unexpected rejections
    })
}
