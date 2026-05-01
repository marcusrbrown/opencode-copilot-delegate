/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from 'bun:test'
import type { TuiDialogProps } from '@opencode-ai/plugin/tui'
import { type JSX, testRender } from '@opentui/solid'
import {
  RpcAuthError,
  RpcServerError,
  RpcUnreachableError,
} from '../rpc-client'

type TaskStatus = 'running' | 'cancelling' | 'complete' | 'failed' | 'cancelled'

type TaskRow = {
  taskId: string
  status: TaskStatus
  agent: string
  model: string
  elapsedMs: number
  toolCallCount: number
  startedAt: number
}

type ConfirmCardProps = {
  Dialog: (props: TuiDialogProps) => JSX.Element
  task: TaskRow
  rpc: {
    tasksCancel(taskId: string): Promise<{ cancelled: boolean; error?: string }>
  }
  onConfirm: () => void
  onCancel: () => void
  onDismissAfterError: () => void
}

type ConfirmCardComponent = (props: ConfirmCardProps) => JSX.Element

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

async function loadConfirmCard(): Promise<ConfirmCardComponent | undefined> {
  await import('@opentui/solid/runtime-plugin-support')

  try {
    const module = await import('../components/confirm-card')
    const confirmCard =
      Reflect.get(module, 'ConfirmCard') ?? Reflect.get(module, 'default')

    if (typeof confirmCard !== 'function') {
      return undefined
    }

    return confirmCard as ConfirmCardComponent
  } catch {
    return undefined
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => {}
  let rejectFn: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })

  return {
    promise,
    resolve(value: T) {
      resolveFn(value)
    },
    reject(error: unknown) {
      rejectFn(error)
    },
  }
}

function createDialogStub() {
  let onClose: (() => void) | undefined

  const Dialog = (props: TuiDialogProps) => {
    onClose = props.onClose
    return <box flexDirection="column">{props.children}</box>
  }

  return {
    Dialog,
    getOnClose: () => onClose,
  }
}

function makeTask(taskId: string, overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId,
    status: 'running',
    agent: 'default',
    model: 'gpt-5',
    elapsedMs: 0,
    toolCallCount: 0,
    startedAt: 0,
    ...overrides,
  }
}

async function settle(
  renderOnce: () => Promise<void>,
  idle: () => Promise<void>,
) {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await renderOnce()
  await idle()
  await renderOnce()
}

async function waitForFrame(options: {
  renderOnce: () => Promise<void>
  idle: () => Promise<void>
  captureCharFrame: () => string
  includes: string
  attempts?: number
}): Promise<string> {
  const attempts = options.attempts ?? 10

  for (let index = 0; index < attempts; index += 1) {
    await settle(options.renderOnce, options.idle)
    const frame = options.captureCharFrame()

    if (frame.includes(options.includes)) {
      return frame
    }
  }

  return options.captureCharFrame()
}

describe('confirm card', () => {
  it('renders the task id and both initial actions', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <ConfirmCard
          Dialog={dialog.Dialog}
          task={makeTask('cpl_abc')}
          rpc={{ tasksCancel: async () => ({ cancelled: true }) }}
          onConfirm={() => {}}
          onCancel={() => {}}
          onDismissAfterError={() => {}}
        />
      ),
      { width: 80, height: 20, useThread: false },
    )

    await renderOnce()

    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: 'Cancel Copilot delegation cpl_abc?',
    })

    expect(frame).toContain('Cancel Copilot delegation cpl_abc?')
    expect(frame).toContain('Cancel Task')
    expect(frame).toContain('Keep Running')
  })

  it('keeps running without calling rpc cancellation', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    const cancelledTaskIds: string[] = []
    let confirmed = 0
    let keptRunning = 0
    let dismissedAfterError = 0

    const { renderOnce, mockInput, renderer } = await testRender(
      () => (
        <ConfirmCard
          Dialog={dialog.Dialog}
          task={makeTask('cpl_keep_running')}
          rpc={{
            tasksCancel: async (taskId) => {
              cancelledTaskIds.push(taskId)
              return { cancelled: true }
            },
          }}
          onConfirm={() => {
            confirmed += 1
          }}
          onCancel={() => {
            keptRunning += 1
          }}
          onDismissAfterError={() => {
            dismissedAfterError += 1
          }}
        />
      ),
      { width: 80, height: 20, useThread: false },
    )

    await renderOnce()
    await settle(renderOnce, () => renderer.idle())

    mockInput.pressArrow('right')
    await settle(renderOnce, () => renderer.idle())
    mockInput.pressEnter()
    await settle(renderOnce, () => renderer.idle())

    expect(cancelledTaskIds).toEqual([])
    expect(confirmed).toBe(0)
    expect(keptRunning).toBe(1)
    expect(dismissedAfterError).toBe(0)
  })

  it('calls rpc cancellation and closes on success', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    const cancelledTaskIds: string[] = []
    let confirmed = 0

    const { renderOnce, mockInput, renderer } = await testRender(
      () => (
        <ConfirmCard
          Dialog={dialog.Dialog}
          task={makeTask('cpl_cancel_success')}
          rpc={{
            tasksCancel: async (taskId) => {
              cancelledTaskIds.push(taskId)
              return { cancelled: true }
            },
          }}
          onConfirm={() => {
            confirmed += 1
          }}
          onCancel={() => {}}
          onDismissAfterError={() => {}}
        />
      ),
      { width: 80, height: 20, useThread: false },
    )

    await renderOnce()
    await settle(renderOnce, () => renderer.idle())

    mockInput.pressEnter()
    await settle(renderOnce, () => renderer.idle())

    expect(cancelledTaskIds).toEqual(['cpl_cancel_success'])
    expect(confirmed).toBe(1)
  })

  it('stays open with an inline error and dismiss action when cancellation fails', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    const { renderOnce, captureCharFrame, mockInput, renderer } =
      await testRender(
        () => (
          <ConfirmCard
            Dialog={dialog.Dialog}
            task={makeTask('cpl_cancel_error')}
            rpc={{
              tasksCancel: async () => {
                throw new RpcUnreachableError('rpc offline')
              },
            }}
            onConfirm={() => {}}
            onCancel={() => {}}
            onDismissAfterError={() => {}}
          />
        ),
        { width: 80, height: 20, useThread: false },
      )

    await renderOnce()
    await settle(renderOnce, () => renderer.idle())

    mockInput.pressEnter()
    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: 'Cancel failed: rpc offline',
    })

    expect(frame).toContain('Cancel failed: rpc offline')
    expect(frame).toContain('Dismiss')
    expect(frame).not.toContain('Keep Running')
  })

  it('renders inline server and auth errors without closing', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const cases = [
      new RpcServerError('server refused cancellation', {
        path: '/tasks/cancel',
        status: 500,
      }),
      new RpcAuthError('token rejected', {
        path: '/tasks/cancel',
        status: 401,
      }),
    ]

    for (const error of cases) {
      const dialog = createDialogStub()
      let confirmed = 0

      const { renderOnce, captureCharFrame, mockInput, renderer } =
        await testRender(
          () => (
            <ConfirmCard
              Dialog={dialog.Dialog}
              task={makeTask('cpl_cancel_error')}
              rpc={{
                tasksCancel: async () => {
                  throw error
                },
              }}
              onConfirm={() => {
                confirmed += 1
              }}
              onCancel={() => {}}
              onDismissAfterError={() => {}}
            />
          ),
          { width: 80, height: 20, useThread: false },
        )

      await renderOnce()
      await settle(renderOnce, () => renderer.idle())
      mockInput.pressEnter()

      const frame = await waitForFrame({
        renderOnce,
        idle: () => renderer.idle(),
        captureCharFrame,
        includes: `Cancel failed: ${error.message}`,
      })

      expect(confirmed).toBe(0)
      expect(frame).toContain(`Cancel failed: ${error.message}`)
      expect(frame).toContain('Dismiss')
    }
  })

  it('dismisses and returns after an inline cancellation error', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    let dismissedAfterError = 0

    const { renderOnce, mockInput, renderer } = await testRender(
      () => (
        <ConfirmCard
          Dialog={dialog.Dialog}
          task={makeTask('cpl_dismiss_after_error')}
          rpc={{
            tasksCancel: async () => {
              throw new RpcUnreachableError('rpc offline')
            },
          }}
          onConfirm={() => {}}
          onCancel={() => {}}
          onDismissAfterError={() => {
            dismissedAfterError += 1
          }}
        />
      ),
      { width: 80, height: 20, useThread: false },
    )

    await renderOnce()
    await settle(renderOnce, () => renderer.idle())

    mockInput.pressEnter()
    await settle(renderOnce, () => renderer.idle())
    mockInput.pressEscape()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await settle(renderOnce, () => renderer.idle())

    expect(dismissedAfterError).toBe(1)
  })

  it('ignores repeated confirm activations while cancellation is in flight', async () => {
    const ConfirmCard = await loadConfirmCard()

    expect(typeof ConfirmCard).toBe('function')
    if (!ConfirmCard) return

    const dialog = createDialogStub()
    const deferred = createDeferred<{ cancelled: boolean }>()
    const cancelledTaskIds: string[] = []
    let confirmed = 0

    const { renderOnce, mockInput, renderer } = await testRender(
      () => (
        <ConfirmCard
          Dialog={dialog.Dialog}
          task={makeTask('cpl_guard')}
          rpc={{
            tasksCancel: async (taskId) => {
              cancelledTaskIds.push(taskId)
              return deferred.promise
            },
          }}
          onConfirm={() => {
            confirmed += 1
          }}
          onCancel={() => {}}
          onDismissAfterError={() => {}}
        />
      ),
      { width: 80, height: 20, useThread: false },
    )

    await renderOnce()
    await settle(renderOnce, () => renderer.idle())

    mockInput.pressEnter()
    mockInput.pressEnter()
    await settle(renderOnce, () => renderer.idle())

    expect(cancelledTaskIds).toEqual(['cpl_guard'])

    deferred.resolve({ cancelled: true })
    await settle(renderOnce, () => renderer.idle())

    expect(confirmed).toBe(1)
  })
})
