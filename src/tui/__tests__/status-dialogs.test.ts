import { describe, expect, it } from 'bun:test'
import type {
  TuiDialogAlertProps,
  TuiDialogConfirmProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from '@opencode-ai/plugin/tui'
import type { JSX } from '@opentui/solid'
import type { TasksCancelResponse } from '../../runtime/rpc-contract'
import { createStatusDialogs, type StatusDialogsRpc } from '../status-dialogs'
import type { StatusTask } from '../status-format'

type Rendered =
  | { kind: 'select'; props: TuiDialogSelectProps<string> }
  | { kind: 'confirm'; props: TuiDialogConfirmProps }
  | { kind: 'alert'; props: TuiDialogAlertProps }

const NOW = 125_000

function makeTask(overrides: Partial<StatusTask> = {}): StatusTask {
  return {
    taskId: 'cpl_alpha',
    status: 'running',
    agent: 'reviewer',
    model: 'gpt-5',
    elapsedMs: 0,
    toolCallCount: 2,
    startedAt: 5_000,
    ...overrides,
  }
}

type Harness = ReturnType<typeof createHarness>

function createHarness(
  options: {
    lists?: Array<StatusTask[] | Error>
    cancel?: (taskId: string) => Promise<TasksCancelResponse>
  } = {},
) {
  const rendered: Rendered[] = []
  const replaceCalls: Array<{ onClose: (() => void) | undefined }> = []
  const sizes: string[] = []
  const cancelCalls: string[] = []
  const deferred: Array<{ fn: () => void; cancelled: boolean }> = []
  let listCalls = 0
  let clearCalls = 0

  const lists = options.lists ?? [[makeTask()]]

  const rpc: StatusDialogsRpc = {
    async tasksList() {
      const next = lists[Math.min(listCalls, lists.length - 1)]
      listCalls += 1

      if (next instanceof Error) {
        throw next
      }

      return { tasks: next }
    },
    async tasksCancel(taskId) {
      cancelCalls.push(taskId)

      return options.cancel
        ? options.cancel(taskId)
        : { cancelled: true as const }
    },
  }

  const api = {
    ui: {
      DialogSelect: ((props: TuiDialogSelectProps<string>) => {
        rendered.push({ kind: 'select', props })
        return null
      }) as unknown as TuiPluginApi['ui']['DialogSelect'],
      DialogConfirm: ((props: TuiDialogConfirmProps) => {
        rendered.push({ kind: 'confirm', props })
        return null
      }) as TuiPluginApi['ui']['DialogConfirm'],
      DialogAlert: ((props: TuiDialogAlertProps) => {
        rendered.push({ kind: 'alert', props })
        return null
      }) as TuiPluginApi['ui']['DialogAlert'],
      dialog: {
        replace: (render: () => JSX.Element, onClose?: () => void) => {
          replaceCalls.push({ onClose })
          render()
        },
        clear: () => {
          clearCalls += 1
        },
        setSize: (size: string) => {
          sizes.push(size)
        },
        size: 'medium',
        depth: 0,
        open: false,
      },
    },
  } as unknown as TuiPluginApi

  const dialogs = createStatusDialogs(api, {
    rpc,
    now: () => NOW,
    defer: (fn) => {
      const entry = { fn, cancelled: false }
      deferred.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  })

  return {
    dialogs,
    rendered,
    replaceCalls,
    sizes,
    cancelCalls,
    deferred,
    get listCalls() {
      return listCalls
    },
    get clearCalls() {
      return clearCalls
    },
    last(): Rendered {
      const entry = rendered.at(-1)
      if (!entry) {
        throw new Error('nothing rendered')
      }
      return entry
    },
    /** Runs everything scheduled via `defer`, like the host timer firing. */
    async runDeferred() {
      for (const entry of deferred.splice(0)) {
        if (!entry.cancelled) {
          entry.fn()
        }
      }
      await flush()
    },
  }
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}

async function open(harness: Harness, taskId?: string) {
  harness.dialogs.openList(taskId)
  await flush()
}

function lastSelect(harness: Harness) {
  const entry = harness.last()
  if (entry.kind !== 'select') {
    throw new Error(`expected select, got ${entry.kind}`)
  }
  return entry.props
}

function lastConfirm(harness: Harness) {
  const entry = harness.last()
  if (entry.kind !== 'confirm') {
    throw new Error(`expected confirm, got ${entry.kind}`)
  }
  return entry.props
}

function lastAlert(harness: Harness) {
  const entry = harness.last()
  if (entry.kind !== 'alert') {
    throw new Error(`expected alert, got ${entry.kind}`)
  }
  return entry.props
}

function selectOption(harness: Harness, value: string) {
  const props = lastSelect(harness)
  const option = props.options.find((candidate) => candidate.value === value)
  if (!option) {
    throw new Error(`no option ${value}`)
  }
  props.onSelect?.(option)
}

describe('status dialogs', () => {
  it('shows one host DialogSelect option per task with status and elapsed time', async () => {
    const harness = createHarness({
      lists: [
        [
          makeTask({ taskId: 'cpl_alpha' }),
          makeTask({
            taskId: 'cpl_beta',
            status: 'cancelling',
            agent: '',
            startedAt: 65_000,
            toolCallCount: 1,
          }),
        ],
      ],
    })

    await open(harness)

    const props = lastSelect(harness)
    expect(harness.sizes).toEqual(['large'])
    expect(props.title).toBe('Copilot delegations (1 running)')
    expect(props.options).toHaveLength(2)
    expect(props.options[0]).toMatchObject({
      title: 'cpl_alpha',
      value: 'cpl_alpha',
      description: 'reviewer · gpt-5 · 2 calls',
      footer: '● running · 2m 0s',
      disabled: false,
    })
    expect(props.options[1]).toMatchObject({
      title: 'cpl_beta',
      description: 'default · gpt-5 · 1 call',
      footer: 'cancelling · 1m 0s',
      disabled: true,
    })
  })

  it('shows an empty-state alert when there are no tasks', async () => {
    const harness = createHarness({ lists: [[]] })

    await open(harness)

    expect(lastAlert(harness).title).toBe('No Copilot delegations are running.')
    expect(harness.sizes).toEqual(['medium'])
  })

  it('opens the cancel confirm when a running task is selected', async () => {
    const harness = createHarness()

    await open(harness)
    selectOption(harness, 'cpl_alpha')

    const confirm = lastConfirm(harness)
    expect(confirm.title).toBe('Cancel Copilot delegation cpl_alpha?')
    expect(harness.sizes).toEqual(['large', 'medium'])
    expect(harness.cancelCalls).toEqual([])
  })

  it('ignores selection of a task that is no longer running', async () => {
    const harness = createHarness({
      lists: [[makeTask({ status: 'cancelling' })]],
    })

    await open(harness)
    selectOption(harness, 'cpl_alpha')

    expect(harness.last().kind).toBe('select')
    expect(harness.replaceCalls).toHaveLength(1)
  })

  it('cancels on confirm and reopens the refreshed list on a deferred tick', async () => {
    const harness = createHarness({
      lists: [[makeTask()], [makeTask({ status: 'cancelling' })]],
    })

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onConfirm?.()
    await flush()

    expect(harness.cancelCalls).toEqual(['cpl_alpha'])
    // Not reopened synchronously: the host clears the confirm after onConfirm.
    expect(harness.replaceCalls).toHaveLength(2)
    expect(harness.deferred).toHaveLength(1)

    await harness.runDeferred()

    expect(harness.listCalls).toBe(2)
    expect(harness.replaceCalls).toHaveLength(3)
    expect(lastSelect(harness).options[0]).toMatchObject({
      footer: expect.stringContaining('cancelling'),
      disabled: true,
    })
  })

  it('treats "no such task" as already finished and reopens the list', async () => {
    const harness = createHarness({
      lists: [[makeTask()], []],
      cancel: async () => ({ cancelled: false, error: 'no such task' }),
    })

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onConfirm?.()
    await flush()
    await harness.runDeferred()

    expect(lastAlert(harness).title).toBe('No Copilot delegations are running.')
    expect(harness.listCalls).toBe(2)
  })

  it('returns to the list without cancelling when the user keeps the task', async () => {
    const harness = createHarness()

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onCancel?.()

    expect(harness.deferred).toHaveLength(1)
    await harness.runDeferred()

    expect(harness.cancelCalls).toEqual([])
    const props = lastSelect(harness)
    expect(props.current).toBe('cpl_alpha')
    expect(harness.listCalls).toBe(2)
  })

  it('shows an alert when the cancel RPC reports a failure, then returns to the list', async () => {
    const harness = createHarness({
      cancel: async () => ({ cancelled: false, error: 'kill failed' }),
    })

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onConfirm?.()
    await flush()
    await harness.runDeferred()

    const alert = lastAlert(harness)
    expect(alert.title).toBe('Could not cancel cpl_alpha')
    expect(alert.message).toBe('kill failed')

    alert.onConfirm?.()
    await harness.runDeferred()

    expect(lastSelect(harness).current).toBe('cpl_alpha')
  })

  it('shows an alert when the cancel RPC throws', async () => {
    const harness = createHarness({
      cancel: async () => {
        throw new Error('connection refused')
      },
    })

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onConfirm?.()
    await flush()
    await harness.runDeferred()

    expect(lastAlert(harness).message).toBe('connection refused')
  })

  it('shows the error state without throwing when the task list fails to load', async () => {
    const harness = createHarness({ lists: [new Error('rpc down')] })

    harness.dialogs.openList()
    await flush()

    const alert = lastAlert(harness)
    expect(alert.title).toBe('Status unavailable.')
    expect(alert.message).toBe('rpc down')
    expect(harness.sizes).toEqual(['medium'])
  })

  it('never re-enters dialog teardown: no clear() and no onClose on any path', async () => {
    const failing = createHarness({
      cancel: async () => ({ cancelled: false, error: 'kill failed' }),
    })
    const succeeding = createHarness()
    const keeping = createHarness()
    const loadFailure = createHarness({ lists: [new Error('rpc down')] })
    const empty = createHarness({ lists: [[]] })

    for (const harness of [failing, succeeding, keeping]) {
      await open(harness)
      selectOption(harness, 'cpl_alpha')
    }
    for (const harness of [failing, succeeding]) {
      lastConfirm(harness).onConfirm?.()
      await flush()
      await harness.runDeferred()
    }
    lastConfirm(keeping).onCancel?.()
    await keeping.runDeferred()
    lastAlert(failing).onConfirm?.()
    await failing.runDeferred()
    await open(loadFailure)
    await open(empty)

    for (const harness of [failing, succeeding, keeping, loadFailure, empty]) {
      expect(harness.clearCalls).toBe(0)
      expect(harness.replaceCalls.length).toBeGreaterThan(0)
      for (const call of harness.replaceCalls) {
        expect(call.onClose).toBeUndefined()
      }
    }
  })

  it('lets only the latest open win when loads overlap', async () => {
    const harness = createHarness({
      lists: [
        [makeTask({ taskId: 'cpl_old' })],
        [makeTask({ taskId: 'cpl_new' })],
      ],
    })

    harness.dialogs.openList()
    harness.dialogs.openList()
    await flush()

    expect(harness.replaceCalls).toHaveLength(1)
    expect(lastSelect(harness).options.map((o) => o.value)).toEqual(['cpl_new'])
  })

  it('drops pending reopens and late results after dispose', async () => {
    const harness = createHarness()

    await open(harness)
    selectOption(harness, 'cpl_alpha')
    lastConfirm(harness).onCancel?.()
    harness.dialogs.dispose()
    await harness.runDeferred()

    expect(harness.replaceCalls).toHaveLength(2)

    harness.dialogs.openList()
    await flush()
    expect(harness.replaceCalls).toHaveLength(2)
  })

  it('keeps a throwing host dialog non-fatal', async () => {
    const warnings: unknown[][] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      const api = {
        ui: {
          DialogSelect: (() => null) as unknown,
          DialogConfirm: (() => null) as unknown,
          DialogAlert: (() => null) as unknown,
          dialog: {
            replace: () => {
              throw new Error('host exploded')
            },
            clear: () => {},
            setSize: () => {},
          },
        },
      } as unknown as TuiPluginApi
      const dialogs = createStatusDialogs(api, {
        rpc: {
          tasksList: async () => ({ tasks: [makeTask()] }),
          tasksCancel: async () => ({ cancelled: true }),
        },
      })

      dialogs.openList()
      await flush()
      dialogs.dispose()

      expect(warnings).toHaveLength(1)
      expect(String(warnings[0][0])).toContain('host exploded')
    } finally {
      console.warn = originalWarn
    }
  })
})
