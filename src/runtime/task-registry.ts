import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessTree } from '../lib/kill-tree'
import type { TaskStatus } from './envelope'
import type { ParsedEvent } from './jsonl-parser'

export type TaskState = {
  taskId: string
  parentSessionID: string
  pid: number
  startedAt: number
  endedAt?: number
  status: TaskStatus
  exitCode?: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
  stdoutLineBuffer: string
  events: ParsedEvent[]
  finalMessage?: string
  errorText?: string
  child: ChildProcess
  completionPromise: Promise<void>
  abortController: AbortController
}

export type CreateTaskInput = Omit<TaskState, 'taskId'>

const tasks = new Map<string, TaskState>()

export function createTask(input: CreateTaskInput): TaskState {
  const taskId = `cpl_${randomUUID()}`
  const task: TaskState = {
    ...input,
    taskId,
  }

  tasks.set(taskId, task)
  return task
}

export function getTask(taskId: string): TaskState | undefined {
  return tasks.get(taskId)
}

export function getAllTasks(): TaskState[] {
  return [...tasks.values()]
}

export async function cleanupAll(): Promise<void> {
  const runningTasks = [...tasks.values()]

  await Promise.allSettled(
    runningTasks.map(async (task) => {
      task.abortController.abort()

      if (task.pid > 0 && task.status === 'running') {
        await killProcessTree(task.pid)
      }
    }),
  )

  tasks.clear()
}
