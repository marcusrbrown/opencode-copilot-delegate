import type { TaskStatus } from './envelope'
import { removePidEntry } from './pid-file'

export interface SetStatusOptions {
  pidFilePath?: string
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  'complete',
  'failed',
  'cancelled',
])
const CANCELLING_STATUS: TaskStatus = 'cancelling'

function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

function isCancellationFinalization(
  currentStatus: TaskStatus,
  newStatus: TaskStatus,
): boolean {
  return currentStatus === CANCELLING_STATUS && newStatus === 'cancelled'
}

/**
 * Transition `task` to `newStatus`, enforcing the forward-only lifecycle.
 *
 * Idempotent on any terminal state (complete, failed, cancelled): once a task
 * reaches a terminal status every subsequent call is a no-op. This prevents
 * both terminal→terminal re-classification and terminal→non-terminal
 * resurrection. When transitioning to a terminal state and `pidFilePath` is
 * provided, the task's PID entry is removed from the orphan-reaper file.
 */
export function setStatus(
  task: { status: TaskStatus; pid: number },
  newStatus: TaskStatus,
  options?: SetStatusOptions,
): void {
  if (isTerminal(task.status)) {
    return
  }

  if (
    task.status === CANCELLING_STATUS &&
    !isCancellationFinalization(task.status, newStatus)
  ) {
    return
  }

  task.status = newStatus

  if (options?.pidFilePath && isTerminal(newStatus)) {
    removePidEntry(options.pidFilePath, task.pid).catch(() => {})
  }
}
