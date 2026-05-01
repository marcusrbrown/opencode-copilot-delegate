/** @jsxImportSource @opentui/solid */

import { TextAttributes } from '@opentui/core'
import type { TasksListResponse } from '../../runtime/rpc-contract'

export type ModalListTask = TasksListResponse['tasks'][number]

type RowProps = {
  task: ModalListTask
  focused: boolean
  nowMs: number
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

function formatStatus(status: ModalListTask['status']): string {
  return status === 'running' ? `● ${status}` : status
}

export function formatToolCalls(toolCallCount: number): string {
  return `${toolCallCount} ${toolCallCount === 1 ? 'call' : 'calls'}`
}

export function formatRowText(task: ModalListTask, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - task.startedAt)

  return `${formatStatus(task.status)}  ${task.taskId}  ${displayValue(task.agent)}  ${displayValue(task.model)}  ${formatElapsed(elapsed)}  ${formatToolCalls(task.toolCallCount)}`
}

export function Row(props: RowProps) {
  const attributes = props.focused
    ? TextAttributes.INVERSE
    : TextAttributes.NONE

  return (
    <text attributes={attributes}>
      {formatRowText(props.task, props.nowMs)}
    </text>
  )
}

export default Row
