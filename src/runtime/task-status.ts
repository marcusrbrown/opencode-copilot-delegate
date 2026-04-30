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

function isTerminal(s: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(s)
}

export function setStatus(
  task: { status: TaskStatus; pid: number },
  newStatus: TaskStatus,
  options?: SetStatusOptions,
): void {
  // Idempotent on terminal state: once a task is terminal (complete,
  // failed, or cancelled), every subsequent setStatus call is a no-op.
  // The forward-only lifecycle forbids both terminal -> terminal
  // transitions (which would lose the original terminal classification)
  // and terminal -> non-terminal transitions (which would resurrect a
  // finalized task).
  if (isTerminal(task.status)) {
    return
  }

  task.status = newStatus

  if (options?.pidFilePath && isTerminal(newStatus)) {
    removePidEntry(options.pidFilePath, task.pid).catch(() => {})
  }
}
