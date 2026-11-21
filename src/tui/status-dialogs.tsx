/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import type { RpcClient } from './rpc-client'
import {
  errorMessage,
  formatTaskDescription,
  formatTaskFooter,
  type StatusTask,
} from './status-format'

/**
 * `/copilot-status` UI built from the host's own dialog components
 * (`DialogSelect`, `DialogConfirm`, `DialogAlert`).
 *
 * The host owns theming, keyboard handling, and dialog teardown (including
 * Esc). This module must therefore never call `api.ui.dialog.clear()` and
 * must never pass an `onClose` to `api.ui.dialog.replace(...)`: feeding
 * host-owned close handling back into `clear()` re-entered dialog teardown
 * and froze the TUI on Esc (see
 * docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md).
 *
 * Host `DialogConfirm` / `DialogAlert` call `dialog.clear()` themselves right
 * after `onConfirm` / `onCancel` returns, so any follow-up dialog is opened on
 * a deferred tick instead of synchronously from those callbacks.
 */

/** Delay before reopening a dialog after a host confirm/alert closes itself. */
const REOPEN_DELAY_MS = 50

export type StatusDialogsRpc = Pick<RpcClient, 'tasksList' | 'tasksCancel'>

export type StatusDialogsOptions = {
  rpc: StatusDialogsRpc
  /** Schedules `fn` after the host's own close has finished. Returns a canceller. */
  defer?: (fn: () => void) => () => void
  now?: () => number
}

export type StatusDialogs = {
  openList: (currentTaskId?: string) => void
  dispose: () => void
}

type DialogApi = Pick<TuiPluginApi, 'ui'>

function warnNonFatal(error: unknown) {
  // The TUI half has no structured log channel; a failure here must never
  // take the host down, so it is reported and swallowed.
  console.warn(
    `[opencode-copilot-delegate] /copilot-status dialog failed: ${errorMessage(error)}`,
  )
}

function defaultDefer(fn: () => void): () => void {
  const handle = setTimeout(fn, REOPEN_DELAY_MS)

  return () => {
    clearTimeout(handle)
  }
}

export function createStatusDialogs(
  api: DialogApi,
  options: StatusDialogsOptions,
): StatusDialogs {
  const { rpc } = options
  const defer = options.defer ?? defaultDefer
  const now = options.now ?? (() => Date.now())
  const pending = new Set<() => void>()
  let disposed = false
  let generation = 0

  const deferred = (fn: () => void) => {
    const cancel = defer(() => {
      pending.delete(cancel)
      if (disposed) {
        return
      }

      try {
        fn()
      } catch (error) {
        warnNonFatal(error)
      }
    })
    pending.add(cancel)
  }

  const showAlert = (
    title: string,
    message: string,
    onConfirm?: () => void,
  ) => {
    api.ui.dialog.setSize('medium')
    api.ui.dialog.replace(() => (
      <api.ui.DialogAlert
        title={title}
        message={message}
        onConfirm={onConfirm}
      />
    ))
  }

  const showCancelFailure = (task: StatusTask, message: string) => {
    showAlert(
      `Could not cancel ${task.taskId}`,
      message,
      // The host closes the alert itself; come back to the list afterwards.
      () => {
        deferred(() => {
          openList(task.taskId)
        })
      },
    )
  }

  const cancelTask = async (task: StatusTask) => {
    let failure: string | undefined

    try {
      const response = await rpc.tasksCancel(task.taskId)

      // "no such task" means it already finished; the refreshed list shows that.
      if (!response.cancelled && response.error !== 'no such task') {
        failure = response.error ?? 'Unknown RPC error.'
      }
    } catch (error) {
      failure = errorMessage(error)
    }

    if (disposed) {
      return
    }

    // The host's DialogConfirm clears itself after `onConfirm`; defer so the
    // next dialog lands after that close rather than inside it.
    deferred(() => {
      if (failure === undefined) {
        openList()
      } else {
        showCancelFailure(task, failure)
      }
    })
  }

  const openConfirm = (task: StatusTask) => {
    api.ui.dialog.setSize('medium')
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title={`Cancel Copilot delegation ${task.taskId}?`}
        message="Confirm stops the running Copilot process. Cancel keeps it running."
        onConfirm={() => {
          void cancelTask(task)
        }}
        onCancel={() => {
          deferred(() => {
            openList(task.taskId)
          })
        }}
      />
    ))
  }

  const renderList = (tasks: StatusTask[], currentTaskId?: string) => {
    if (tasks.length === 0) {
      showAlert(
        'No Copilot delegations are running.',
        'Start one with the copilot_delegate tool, then reopen /copilot-status.',
      )
      return
    }

    const nowMs = now()
    const byId = new Map(tasks.map((task) => [task.taskId, task]))
    const running = tasks.filter((task) => task.status === 'running').length

    api.ui.dialog.setSize('large')
    api.ui.dialog.replace(() => (
      <api.ui.DialogSelect<string>
        title={`Copilot delegations (${running} running)`}
        current={currentTaskId}
        options={tasks.map((task) => ({
          title: task.taskId,
          value: task.taskId,
          description: formatTaskDescription(task),
          footer: formatTaskFooter(task, nowMs),
          // Only a running task can be cancelled.
          disabled: task.status !== 'running',
        }))}
        onSelect={(option) => {
          const task = byId.get(option.value)

          if (task?.status === 'running') {
            openConfirm(task)
          }
        }}
      />
    ))
  }

  const openList = (currentTaskId?: string) => {
    const mine = ++generation

    void (async () => {
      let tasks: StatusTask[]

      try {
        tasks = (await rpc.tasksList()).tasks
      } catch (error) {
        if (!disposed && mine === generation) {
          showAlert('Status unavailable.', errorMessage(error))
        }
        return
      }

      // A newer open, or disposal, supersedes this load.
      if (disposed || mine !== generation) {
        return
      }

      renderList(tasks, currentTaskId)
    })().catch(warnNonFatal)
  }

  return {
    openList,
    dispose() {
      disposed = true
      for (const cancel of pending) {
        cancel()
      }
      pending.clear()
    },
  }
}
