import { randomUUID } from 'node:crypto'
import { killProcessTree } from '../lib/kill-tree'
import { getPidIdentity } from './orphan-reaper'
import { appendPidEntry } from './pid-file'
import type { SpawnCopilotResult } from './subprocess'

/**
 * Source of a TaskState.
 *
 * - `spawn` — fresh `copilot -p` subprocess started by `copilot_delegate`.
 * - `resume` — `copilot --resume=<id>` continuation of a prior session.
 * - `connect` — `copilot --connect=<id>` attach to a running session
 *   (deferred from the v0.x first slice; the type seam is in place for
 *   forward compatibility per the S2 plan amendment).
 */
export type TaskOrigin = 'spawn' | 'resume' | 'connect'

export type TaskState = SpawnCopilotResult & {
  parentSessionID: string
  startedAt: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
  origin: TaskOrigin
  /** Workspace paths passed via `--add-dir` (captured for resume reuse). */
  addDirs?: string[]
  /** ps comm + lstart captured at spawn time for connect identity gating. */
  psIdentity?: { comm: string; lstart: string }
}

export type CreateTaskInput = Omit<SpawnCopilotResult, 'taskId'> & {
  parentSessionID: string
  startedAt: number
  args: string[]
  cwd: string
  agentName?: string
  modelName?: string
  /**
   * Source of the task. Optional on input — defaults to `'spawn'` so
   * existing call sites that predate the discriminator keep working.
   */
  origin?: TaskOrigin
  addDirs?: string[]
  psIdentity?: { comm: string; lstart: string }
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
    // Existing call sites (delegate.ts) predate the discriminator; default
    // to 'spawn' so they keep working without explicit `origin` until
    // Unit 3c lands the resume tool. Explicit values from the input are
    // preserved by the spread above.
    origin: rest.origin ?? 'spawn',
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
            `[copilot-delegate] ps lookup returned null for pid ${task.pid}; subprocess will not be tracked for orphan reaping`,
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
