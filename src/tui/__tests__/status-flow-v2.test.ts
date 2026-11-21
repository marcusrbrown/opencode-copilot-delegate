import { describe, expect, it } from 'bun:test'
import type { TasksCancelResponse } from '../../runtime/rpc-contract'
import {
  createStatusFlow,
  type StatusFlowDialog,
  type StatusFlowRpc,
} from '../status-flow-v2'
import type { StatusTask } from '../status-format'

type SelectOptions = Parameters<StatusFlowDialog['select']>[0]
type ConfirmOptions = Parameters<StatusFlowDialog['confirm']>[0]
type AlertOptions = Parameters<StatusFlowDialog['alert']>[0]

/**
 * A stand-in for the V2 host dialog: every call opens a dialog that the test
 * settles by hand (`pick`, `confirm`, `dismiss`), the way the host settles a
 * dialog promise when the user acts or presses Esc. `clear` and `show` are
 * spies on the object the flow receives; the flow must never touch them.
 */
function createFakeDialog() {
  type Pending = {
    kind: 'select' | 'confirm' | 'alert'
    options: SelectOptions | ConfirmOptions | AlertOptions
    settle: (value: unknown) => void
  }

  const opened: Pending[] = []
  const sizes: Array<string | undefined> = []
  let clearCalls = 0
  let showCalls = 0

  const open = <T>(entry: Omit<Pending, 'settle'>) =>
    new Promise<T>((resolve) => {
      // A newer dialog replaces the active one; the host settles the old
      // dialog's promise with `undefined` when that happens.
      opened.at(-1)?.settle(undefined)
      opened.push({ ...entry, settle: resolve as (v: unknown) => void })
    })

  const dialog = {
    select: (options: SelectOptions) => open({ kind: 'select', options }),
    confirm: (options: ConfirmOptions) => open({ kind: 'confirm', options }),
    alert: (options: AlertOptions) => open<void>({ kind: 'alert', options }),
    set: (options: { size?: string }) => {
      sizes.push(options.size)
    },
    clear: () => {
      clearCalls += 1
    },
    show: () => {
      showCalls += 1
    },
  }

  return {
    dialog: dialog as unknown as StatusFlowDialog,
    opened,
    sizes,
    get clearCalls() {
      return clearCalls
    },
    get showCalls() {
      return showCalls
    },
    active() {
      return opened.at(-1)
    },
    activeTitle(): unknown {
      return (opened.at(-1)?.options as { title?: unknown } | undefined)?.title
    },
    /** Options of the active dialog, which must be a select. */
    selectOptions(): SelectOptions {
      const active = opened.at(-1)
      if (active?.kind !== 'select') throw new Error('no select is open')
      return active.options as SelectOptions
    },
    /** What the host does on Esc: the open dialog's promise settles with undefined. */
    escape() {
      opened.at(-1)?.settle(undefined)
    },
    settleActive(value: unknown) {
      opened.at(-1)?.settle(value)
    },
  }
}

function task(overrides: Partial<StatusTask> = {}): StatusTask {
  return {
    taskId: 'cpl_alpha',
    status: 'running',
    agent: 'default',
    model: 'gpt-5',
    elapsedMs: 0,
    toolCallCount: 1,
    startedAt: 0,
    ...overrides,
  } as StatusTask
}

function fakeRpc(options: {
  tasks?: StatusTask[][]
  list?: () => Promise<{ tasks: StatusTask[] }>
  cancel?: (taskId: string) => Promise<TasksCancelResponse>
}) {
  const cancelled: string[] = []
  let listCalls = 0
  const rpc: StatusFlowRpc = {
    tasksList: options.list
      ? options.list
      : async () => {
          const frames = options.tasks ?? [[]]
          const frame = frames[Math.min(listCalls, frames.length - 1)]
          listCalls += 1
          return { tasks: frame } as { tasks: StatusTask[] }
        },
    tasksCancel: async (taskId) => {
      cancelled.push(taskId)
      return options.cancel ? options.cancel(taskId) : { cancelled: true }
    },
  }

  return {
    rpc,
    cancelled,
    get listCalls() {
      return listCalls
    },
  }
}

// Macrotask turns drain every pending promise continuation in the flow.
async function flush(times = 4) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('V2 status flow', () => {
  it('shows a large host select with one option per task and disables settled tasks', async () => {
    const host = createFakeDialog()
    const { rpc } = fakeRpc({
      tasks: [
        [
          task(),
          task({ taskId: 'cpl_beta', status: 'complete', agent: 'reviewer' }),
        ],
      ],
    })
    const flow = createStatusFlow(host.dialog, { rpc, now: () => 0 })

    flow.open()
    await flush()

    expect(host.active()?.kind).toBe('select')
    const options = host.selectOptions().options
    expect(options.map((option) => option.value)).toEqual([
      'cpl_alpha',
      'cpl_beta',
    ])
    expect(options.map((option) => option.disabled)).toEqual([false, true])
    expect(host.sizes).toEqual(['large'])
  })

  it('never calls clear or show when the user presses Esc on the list', async () => {
    const host = createFakeDialog()
    const { rpc } = fakeRpc({ tasks: [[task()]] })
    const flow = createStatusFlow(host.dialog, { rpc, now: () => 0 })

    flow.open()
    await flush()
    host.escape()
    await flush()

    expect(host.opened).toHaveLength(1)
    expect(host.clearCalls).toBe(0)
    expect(host.showCalls).toBe(0)
  })

  it('never calls clear or show when the user presses Esc on the confirm', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({ tasks: [[task()]] })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    host.settleActive('cpl_alpha')
    await flush()
    expect(host.active()?.kind).toBe('confirm')

    host.escape()
    await flush()

    expect(host.opened).toHaveLength(2)
    expect(fake.cancelled).toEqual([])
    expect(host.clearCalls).toBe(0)
    expect(host.showCalls).toBe(0)
  })

  it('returns to the list, keeping the selection, when the confirm is declined', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({ tasks: [[task()]] })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    host.settleActive('cpl_alpha')
    await flush()
    host.settleActive(false)
    await flush()

    expect(host.opened.map((entry) => entry.kind)).toEqual([
      'select',
      'confirm',
      'select',
    ])
    expect(host.selectOptions().current).toBe('cpl_alpha')
    expect(fake.cancelled).toEqual([])
  })

  it('cancels the task on confirm and then shows the refreshed list', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({
      tasks: [[task()], [task({ status: 'cancelled' })]],
    })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    host.settleActive('cpl_alpha')
    await flush()
    host.settleActive(true)
    await flush()

    expect(fake.cancelled).toEqual(['cpl_alpha'])
    expect(fake.listCalls).toBe(2)
    expect(host.active()?.kind).toBe('select')
    expect(host.selectOptions().options[0]?.disabled).toBe(true)
    expect(host.clearCalls).toBe(0)
  })

  it('treats "no such task" as already finished rather than a failure', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({
      tasks: [[task()], [task({ status: 'complete' })]],
      cancel: async () => ({ cancelled: false, error: 'no such task' }),
    })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    host.settleActive('cpl_alpha')
    await flush()
    host.settleActive(true)
    await flush()

    expect(host.opened.map((entry) => entry.kind)).toEqual([
      'select',
      'confirm',
      'select',
    ])
  })

  it('alerts with the cancel failure, then returns to the list', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({
      tasks: [[task()]],
      cancel: async () => {
        throw new Error('rpc went away')
      },
    })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    host.settleActive('cpl_alpha')
    await flush()
    host.settleActive(true)
    await flush()

    expect(host.active()?.kind).toBe('alert')
    expect(host.active()?.options).toEqual({
      title: 'Could not cancel cpl_alpha',
      message: 'rpc went away',
    })

    host.settleActive(undefined)
    await flush()
    expect(host.active()?.kind).toBe('select')
  })

  it('renders an error alert, without throwing, when the list RPC fails', async () => {
    const host = createFakeDialog()
    const { rpc } = fakeRpc({
      list: async () => {
        throw new Error('port file is unavailable')
      },
    })
    const flow = createStatusFlow(host.dialog, { rpc, now: () => 0 })

    expect(() => flow.open()).not.toThrow()
    await flush()

    expect(host.active()?.kind).toBe('alert')
    expect(host.active()?.options).toEqual({
      title: 'Status unavailable.',
      message: 'port file is unavailable',
    })
    expect(host.clearCalls).toBe(0)
  })

  it('alerts when there are no delegations', async () => {
    const host = createFakeDialog()
    const { rpc } = fakeRpc({ tasks: [[]] })
    const flow = createStatusFlow(host.dialog, { rpc, now: () => 0 })

    flow.open()
    await flush()

    expect(host.active()?.kind).toBe('alert')
    expect(host.activeTitle()).toBe('No Copilot delegations are running.')
  })

  it('lets a newer open supersede an older one', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({ tasks: [[task()]] })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    flow.open()
    await flush()

    // The second list replaced the first; settling the replaced dialog with
    // undefined (as the host does) must not end the newer flow.
    expect(host.opened.map((entry) => entry.kind)).toEqual(['select', 'select'])
    host.settleActive('cpl_alpha')
    await flush()
    expect(host.active()?.kind).toBe('confirm')
  })

  it('stops after dispose without opening anything further', async () => {
    const host = createFakeDialog()
    const fake = fakeRpc({ tasks: [[task()]] })
    const flow = createStatusFlow(host.dialog, { rpc: fake.rpc, now: () => 0 })

    flow.open()
    await flush()
    flow.dispose()
    host.settleActive('cpl_alpha')
    await flush()

    expect(host.opened).toHaveLength(1)
    expect(fake.cancelled).toEqual([])
  })
})
