import type { TasksListResponse } from '../runtime/rpc-contract'

export type StatusTask = TasksListResponse['tasks'][number]

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return 'Unknown RPC error.'
}

export function displayValue(value: string): string {
  const trimmed = value.trim()

  return trimmed.length > 0 ? trimmed : 'default'
}

export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000))

  if (totalSeconds >= 3_600) {
    const hours = Math.floor(totalSeconds / 3_600)
    const minutes = Math.floor((totalSeconds % 3_600) / 60)
    return `${hours}h ${minutes}m`
  }

  if (totalSeconds >= 60) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}m ${seconds}s`
  }

  return `${totalSeconds}s`
}

export function formatStatus(status: StatusTask['status']): string {
  return status === 'running' ? `● ${status}` : status
}

export function formatToolCalls(toolCallCount: number): string {
  return `${toolCallCount} ${toolCallCount === 1 ? 'call' : 'calls'}`
}

/** Secondary line of a list option: who is running it and how busy it is. */
export function formatTaskDescription(task: StatusTask): string {
  return `${displayValue(task.agent)} · ${displayValue(task.model)} · ${formatToolCalls(task.toolCallCount)}`
}

/** Right-hand footer of a list option: status and elapsed time. */
export function formatTaskFooter(task: StatusTask, nowMs: number): string {
  return `${formatStatus(task.status)} · ${formatElapsed(Math.max(0, nowMs - task.startedAt))}`
}
