export type CancelTaskResult = {
  cancelled: boolean
  error?: string
}

export type CancelTaskRegistry = {
  getTask: (taskId: string) =>
    | {
        abortController: AbortController
      }
    | undefined
}

export function cancelTaskById(
  taskRegistry: CancelTaskRegistry,
  taskId: string,
): CancelTaskResult {
  const task = taskRegistry.getTask(taskId)

  if (!task) {
    return { cancelled: false, error: 'no such task' }
  }

  task.abortController.abort()
  return { cancelled: true }
}
