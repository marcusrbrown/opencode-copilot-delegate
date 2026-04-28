import { randomUUID } from 'node:crypto'
import { killProcessTree } from '../lib/kill-tree'
import { getPidIdentity } from './orphan-reaper'
import { appendPidEntry } from './pid-file'
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
  pidFilePath?: string
}

const tasks = new Map<string, TaskState>()

export function createTask(
  input: CreateTaskInput,
  taskId = `cpl_${randomUUID()}`,
): TaskState {
  const { pidFilePath, ...rest } = input
  const task: TaskState = {
    ...rest,
    taskId,
  }

  if (task.pid > 0 && pidFilePath) {
    getPidIdentity(task.pid)
      .then((identity) => {
        if (identity) {
          appendPidEntry(
            pidFilePath,
            task.pid,
            identity.comm,
            identity.lstart,
          ).catch(() => {})
        } else {
          // ps lookup returned null. Most likely the process has already
          // exited (e.g., copilot CLI failed to launch), but it could also
          // mean the kernel hasn't surfaced the entry yet. Either way, the
          // subprocess is invisible to the orphan reaper. Surface a warning
          // so degraded coverage is observable.
          console.warn(
            `[task-registry] ps lookup returned null for pid ${task.pid}; subprocess will not be tracked for orphan reaping`,
          )
        }
      })
      .catch(() => {})
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
