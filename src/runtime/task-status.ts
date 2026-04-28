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
  if (isTerminal(task.status) && isTerminal(newStatus)) {
    return
  }

  task.status = newStatus

  if (options?.pidFilePath && isTerminal(newStatus)) {
    removePidEntry(options.pidFilePath, task.pid).catch(() => {})
  }
}
