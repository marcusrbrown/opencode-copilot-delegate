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

/** Minimal client interface for notification injection. */
export type NotifyClient = {
  session: {
    prompt: (opts: {
      path: { id: string }
      body: {
        noReply: boolean
        parts: Array<{ type: string; text: string; synthetic: boolean }>
      }
    }) => Promise<unknown>
  }
  tui: {
    showToast: (opts: { body: { message: string; variant: string } }) => void
  }
  app: {
    log: (...args: unknown[]) => void
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
}

/** Per-parent-session in-flight task counters. */
const inFlightCounters = new Map<string, number>()

/** Increment the in-flight counter for a parent session. */
export function incrementInFlight(parentSessionID: string): void {
  const current = inFlightCounters.get(parentSessionID) ?? 0
  inFlightCounters.set(parentSessionID, current + 1)
}

/** Reset all counters (for testing only). */
export function resetInFlightCounters(): void {
  inFlightCounters.clear()
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

/** Build the `<system-reminder>` notification text. */
function buildNotificationText(task: NotifyTaskInfo): string {
  const agent = task.agentName ?? 'default'
  const model = task.modelName ?? 'default'
  const duration = formatDuration(Date.now() - task.startedAt)

  let text = `<system-reminder>
[COPILOT DELEGATION COMPLETED]
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
  const current = inFlightCounters.get(task.parentSessionID) ?? 0
  const remaining = Math.max(0, current - 1)
  if (remaining === 0) {
    inFlightCounters.delete(task.parentSessionID)
  } else {
    inFlightCounters.set(task.parentSessionID, remaining)
  }

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
    client.app.log(
      'notify',
      `Failed to inject notification for ${task.taskId}: ${error}`,
    )
  }

  try {
    const variant = task.status === 'complete' ? 'success' : 'error'
    const toastMessage =
      task.status === 'complete'
        ? `Copilot delegation ${task.taskId} completed`
        : `Copilot delegation ${task.taskId} ${task.status}`

    client.tui.showToast({
      body: { message: toastMessage, variant },
    })
  } catch {
    // Toast failure is non-critical
  }
}
