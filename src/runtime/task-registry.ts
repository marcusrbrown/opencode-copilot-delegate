import { randomUUID } from 'node:crypto'
import { killProcessTree } from '../lib/kill-tree'
import type { SpawnCopilotResult } from './subprocess'

export type TaskState = SpawnCopilotResult & {
  parentSessionID: string
  startedAt: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
}

export type CreateTaskInput = Omit<SpawnCopilotResult, 'taskId'> & {
  parentSessionID: string
  startedAt: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
}

const tasks = new Map<string, TaskState>()

export function createTask(
  input: CreateTaskInput,
  taskId = `cpl_${randomUUID()}`,
): TaskState {
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

export function deleteTask(taskId: string): boolean {
  return tasks.delete(taskId)
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
