import type { Plugin } from '@opencode/plugin/tui'
import type { RpcClient } from './rpc-client'
import {
  errorMessage,
  formatTaskDescription,
  formatTaskFooter,
  type StatusTask,
} from './status-format'

/**
 * `/copilot-status` on OpenCode V2, built only from the host's promise-based
 * dialogs (`dialog.select`, `dialog.confirm`, `dialog.alert`).
 *
 * Those helpers own their own close handling: each settles exactly once,
 * whether the user confirms, cancels, or presses Esc, and the host clears the
 * dialog before the promise continuation runs. So this module never calls
 * `dialog.clear()`, never passes `onClose`, and renders no JSX: the V1
 * re-entrant-close failure (see
 * docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md)
 * has no surface to recur on.
 *
 * Every dialog is a step in one sequential flow (list, confirm, cancel,
 * back to the list), so there are no deferred reopen timers.
 */

export type StatusFlowRpc = Pick<RpcClient, 'tasksList' | 'tasksCancel'>

export type StatusFlowDialog = Pick<
  Plugin.Context['ui']['dialog'],
  'select' | 'confirm' | 'alert' | 'set'
>

export type StatusFlowOptions = {
  rpc: StatusFlowRpc
  now?: () => number
}

export type StatusFlow = {
  /** Starts (or restarts) the flow. Never rejects; a newer call supersedes an older one. */
  open: () => void
  dispose: () => void
}

function warnNonFatal(error: unknown) {
  // The TUI half has no structured log channel; a failure here must never
  // take the host down, so it is reported and swallowed.
  console.warn(
    `[opencode-copilot-delegate] /copilot-status dialog failed: ${errorMessage(error)}`,
  )
}

export function createStatusFlow(
  dialog: StatusFlowDialog,
  options: StatusFlowOptions,
): StatusFlow {
  const { rpc } = options
  const now = options.now ?? (() => Date.now())
  let disposed = false
  let generation = 0

  const isCurrent = (mine: number) => !disposed && mine === generation

  const selectTask = (tasks: StatusTask[], currentTaskId?: string) => {
    const nowMs = now()
    const running = tasks.filter((task) => task.status === 'running').length
    const picked = dialog.select<string>({
      title: `Copilot delegations (${running} running)`,
      current: currentTaskId,
      options: tasks.map((task) => ({
        title: task.taskId,
        value: task.taskId,
        description: formatTaskDescription(task),
        footer: formatTaskFooter(task, nowMs),
        // Only a running task can be cancelled.
        disabled: task.status !== 'running',
      })),
    })

    // `show` resets the dialog to the medium size, so the size is set after
    // it. `select` shows synchronously, which makes this the earliest point.
    dialog.set({ size: 'large' })

    return picked
  }

  const cancelTask = async (task: StatusTask): Promise<string | undefined> => {
    try {
      const response = await rpc.tasksCancel(task.taskId)

      // "no such task" means it already finished; the refreshed list shows that.
      if (!response.cancelled && response.error !== 'no such task') {
        return response.error ?? 'Unknown RPC error.'
      }
    } catch (error) {
      return errorMessage(error)
    }

    return undefined
  }

  /** Loads the tasks, or alerts and returns `undefined` when the flow should stop. */
  const loadTasks = async (mine: number): Promise<StatusTask[] | undefined> => {
    let tasks: StatusTask[]

    try {
      tasks = (await rpc.tasksList()).tasks
    } catch (error) {
      if (isCurrent(mine)) {
        await dialog.alert({
          title: 'Status unavailable.',
          message: errorMessage(error),
        })
      }
      return undefined
    }

    if (!isCurrent(mine)) {
      return undefined
    }

    if (tasks.length === 0) {
      await dialog.alert({
        title: 'No Copilot delegations are running.',
        message:
          'Start one with the copilot_delegate tool, then reopen /copilot-status.',
      })
      return undefined
    }

    return tasks
  }

  /**
   * Confirms, then cancels. `stop` ends the flow (Esc or superseded),
   * `refreshed` means the task was cancelled, and `kept` returns to the list
   * with the selection preserved (declined, or the cancel failed).
   */
  const confirmAndCancel = async (
    mine: number,
    task: StatusTask,
  ): Promise<'stop' | 'refreshed' | 'kept'> => {
    const confirmed = await dialog.confirm({
      title: `Cancel Copilot delegation ${task.taskId}?`,
      message:
        'Confirm stops the running Copilot process. Cancel keeps it running.',
    })

    // Esc settles with undefined; declining settles with false.
    if (!isCurrent(mine) || confirmed === undefined) {
      return 'stop'
    }

    if (!confirmed) {
      return 'kept'
    }

    const failure = await cancelTask(task)

    if (!isCurrent(mine)) {
      return 'stop'
    }

    if (failure === undefined) {
      return 'refreshed'
    }

    await dialog.alert({
      title: `Could not cancel ${task.taskId}`,
      message: failure,
    })

    return 'kept'
  }

  /**
   * One pass through the list. Returns `stop` to end the flow, or the task to
   * keep selected when the list is shown again.
   */
  const step = async (
    mine: number,
    selected: string | undefined,
  ): Promise<'stop' | { selected: string | undefined }> => {
    const tasks = await loadTasks(mine)

    if (tasks === undefined) {
      return 'stop'
    }

    const pickedId = await selectTask(tasks, selected)

    // Esc (or a newer dialog replacing this one) settles with undefined.
    if (pickedId === undefined || !isCurrent(mine)) {
      return 'stop'
    }

    const task = tasks.find((candidate) => candidate.taskId === pickedId)

    if (task?.status !== 'running') {
      return { selected: pickedId }
    }

    const outcome = await confirmAndCancel(mine, task)

    if (outcome === 'stop') {
      return 'stop'
    }

    return { selected: outcome === 'refreshed' ? undefined : pickedId }
  }

  const run = async (mine: number) => {
    let selected: string | undefined

    while (isCurrent(mine)) {
      const next = await step(mine, selected)

      if (next === 'stop') {
        return
      }

      selected = next.selected
    }
  }

  return {
    open() {
      const mine = ++generation

      run(mine).catch(warnNonFatal)
    },
    dispose() {
      disposed = true
    },
  }
}
