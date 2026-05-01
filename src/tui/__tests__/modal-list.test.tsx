import { afterEach, describe, expect, it } from 'bun:test'
import type { TuiDialogProps } from '@opencode-ai/plugin/tui'
import { type JSX, testRender } from '@opentui/solid'

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

type TasksListResponse = {
  tasks: TaskRow[]
}

type ModalListClock = {
  now(): number
  setInterval(fn: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

type ModalListProps = {
  Dialog: (props: TuiDialogProps) => JSX.Element
  rpc: {
    tasksList(): Promise<TasksListResponse>
  }
  onClose: () => void
  onCancelTask?: (task: TaskRow) => void
  clock?: ModalListClock
}

type ModalListComponent = (props: ModalListProps) => JSX.Element

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

class TestClock {
  private time: number
  private nextId = 1
  private readonly intervals = new Map<
    number,
    {
      delayMs: number
      nextAt: number
      fn: () => void
    }
  >()
  readonly cleared: number[] = []

  constructor(startAt = 0) {
    this.time = startAt
  }

  now(): number {
    return this.time
  }

  setInterval(fn: () => void, delayMs: number): number {
    const id = this.nextId
    this.nextId += 1
    this.intervals.set(id, {
      delayMs,
      nextAt: this.time + delayMs,
      fn,
    })
    return id
  }

  clearInterval(handle: unknown): void {
    const id = Number(handle)
    this.cleared.push(id)
    this.intervals.delete(id)
  }

  advance(delayMs: number): void {
    const target = this.time + delayMs

    while (true) {
      let nextId: number | undefined
      let nextAt = Number.POSITIVE_INFINITY

      for (const [id, interval] of this.intervals) {
        if (interval.nextAt < nextAt) {
          nextAt = interval.nextAt
          nextId = id
        }
      }

      if (nextId === undefined || nextAt > target) {
        break
      }

      const interval = this.intervals.get(nextId)
      if (!interval) {
        break
      }

      this.time = interval.nextAt
      interval.fn()

      const updated = this.intervals.get(nextId)
      if (updated) {
        updated.nextAt += updated.delayMs
      }
    }

    this.time = target
  }

  get activeIntervalCount(): number {
    return this.intervals.size
  }

  adapter(): ModalListClock {
    return {
      now: () => this.now(),
      setInterval: (fn, delayMs) => this.setInterval(fn, delayMs),
      clearInterval: (handle) => this.clearInterval(handle),
    }
  }
}

async function loadModalList(): Promise<ModalListComponent> {
  await import('@opentui/solid/runtime-plugin-support')

  const module = await import('../components/modal-list')
  const modalList =
    Reflect.get(module, 'ModalList') ?? Reflect.get(module, 'default')

  expect(typeof modalList).toBe('function')

  return modalList as ModalListComponent
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

type CaptureSpans = Awaited<ReturnType<typeof testRender>>['captureSpans']
type CapturedFrame = ReturnType<CaptureSpans>

function findLineAttributesContaining(frame: CapturedFrame, text: string) {
  return frame.lines.find((line) =>
    line.spans.some((span) => span.text.includes(text)),
  )
}

function lineHasInverse(
  line: CapturedFrame['lines'][number] | undefined,
): boolean {
  if (!line) {
    return false
  }

  return line.spans.some(
    (span) => span.text.trim().length > 0 && span.attributes !== 0,
  )
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

afterEach(() => {
  // Test files import runtime plugin support dynamically.
  // No global cleanup is needed beyond renderer teardown.
})

describe('modal list', () => {
  it('renders a loading state before tasksList resolves', async () => {
    const ModalList = await loadModalList()
    const deferred = createDeferred<TasksListResponse>()
    const dialog = createDialogStub()
    let calls = 0

    const { renderOnce, captureCharFrame } = await testRender(
      () => (
        <ModalList
          Dialog={dialog.Dialog}
          rpc={{
            tasksList: () => {
              calls += 1
              return deferred.promise
            },
          }}
          onClose={() => {}}
        />
      ),
      { width: 120, height: 20, useThread: false },
    )

    await renderOnce()

    const frame = captureCharFrame()
    expect(calls).toBe(1)
    expect(frame).toContain('Loading delegations')
    expect(frame).toContain('Esc close')
  })

  it('renders an empty state after tasksList returns no tasks', async () => {
    const ModalList = await loadModalList()
    const dialog = createDialogStub()

    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <ModalList
          Dialog={dialog.Dialog}
          rpc={{ tasksList: async () => ({ tasks: [] }) }}
          onClose={() => {}}
        />
      ),
      { width: 120, height: 20, useThread: false },
    )

    await renderOnce()

    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: '0 running · 0 recent',
    })
    expect(frame).toContain('0 running · 0 recent')
    expect(frame).toContain('No Copilot delegations are running.')
    expect(frame).toContain(
      'Start one with the copilot_delegate tool, then reopen /copilot-status.',
    )
    expect(frame).toContain('Esc close')
  })

  it('renders an error state with the rpc rejection message', async () => {
    const ModalList = await loadModalList()
    const dialog = createDialogStub()

    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <ModalList
          Dialog={dialog.Dialog}
          rpc={{
            tasksList: async () => {
              throw new Error('rpc exploded on localhost')
            },
          }}
          onClose={() => {}}
        />
      ),
      { width: 120, height: 20, useThread: false },
    )

    await renderOnce()

    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: 'Status unavailable.',
    })
    expect(frame).toContain('Status unavailable.')
    expect(frame).toContain('rpc exploded on localhost')
    expect(frame).toContain('Esc close')
  })

  it('renders running rows with focused styling, defaults, and key navigation', async () => {
    const ModalList = await loadModalList()
    const dialog = createDialogStub()
    const clock = new TestClock(2_000)
    const cancelled: TaskRow[] = []
    const tasks = [
      makeTask('cpl_alpha', {
        startedAt: 0,
        toolCallCount: 3,
      }),
      makeTask('cpl_beta', {
        agent: '',
        model: '',
        startedAt: 1_000,
        toolCallCount: 1,
      }),
      makeTask('cpl_gamma', {
        agent: 'reviewer',
        model: 'claude-sonnet-4.7',
        startedAt: 2_000,
        toolCallCount: 5,
      }),
    ]

    const { renderOnce, captureCharFrame, captureSpans, mockInput, renderer } =
      await testRender(
        () => (
          <ModalList
            Dialog={dialog.Dialog}
            rpc={{ tasksList: async () => ({ tasks }) }}
            onClose={() => {}}
            onCancelTask={(task) => cancelled.push(task)}
            clock={clock.adapter()}
          />
        ),
        { width: 120, height: 20, useThread: false },
      )

    await renderOnce()

    const frame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: '3 running · 0 recent',
    })
    expect(frame).toContain('3 running · 0 recent')
    expect(frame).toContain('↑↓ navigate · c cancel · Esc close')
    expect(frame).toContain('cpl_alpha')
    expect(frame).toContain('cpl_beta')
    expect(frame).toContain('cpl_gamma')
    expect(frame).toContain('default')
    expect(frame).toContain('reviewer')
    expect(frame).toContain('claude-sonnet-4.7')
    expect(frame).toContain('3 calls')
    expect(frame).toContain('5 calls')
    expect(frame).toContain('0s')

    let spans = captureSpans()
    const firstLine = findLineAttributesContaining(spans, 'cpl_alpha')
    expect(firstLine).toBeDefined()
    expect(lineHasInverse(firstLine)).toBe(true)

    mockInput.pressKey('j')
    await settle(renderOnce, () => renderer.idle())
    expect(captureCharFrame()).toContain('cpl_beta')
    spans = captureSpans()
    const secondLine = findLineAttributesContaining(spans, 'cpl_beta')
    expect(secondLine).toBeDefined()
    expect(lineHasInverse(secondLine)).toBe(true)

    mockInput.pressArrow('up')
    await settle(renderOnce, () => renderer.idle())
    spans = captureSpans()
    const wrappedLine = findLineAttributesContaining(spans, 'cpl_alpha')
    expect(wrappedLine).toBeDefined()
    expect(lineHasInverse(wrappedLine)).toBe(true)

    mockInput.pressKey('k')
    await settle(renderOnce, () => renderer.idle())
    spans = captureSpans()
    const lastLine = findLineAttributesContaining(spans, 'cpl_gamma')
    expect(lastLine).toBeDefined()
    expect(lineHasInverse(lastLine)).toBe(true)

    mockInput.pressKey('c')
    await settle(renderOnce, () => renderer.idle())

    expect(cancelled).toEqual([tasks[2]])
  })

  it('updates elapsed time from an injected clock without waiting on wall time', async () => {
    const ModalList = await loadModalList()
    const dialog = createDialogStub()
    const clock = new TestClock(0)

    const { renderOnce, captureCharFrame, renderer } = await testRender(
      () => (
        <ModalList
          Dialog={dialog.Dialog}
          rpc={{
            tasksList: async () => ({
              tasks: [
                makeTask('cpl_elapsed', {
                  startedAt: 0,
                }),
              ],
            }),
          }}
          onClose={() => {}}
          clock={clock.adapter()}
        />
      ),
      { width: 120, height: 20, useThread: false },
    )

    await renderOnce()
    const readyFrame = await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame,
      includes: '0s',
    })
    expect(readyFrame).toContain('0s')

    clock.advance(1_100)
    await renderOnce()

    expect(captureCharFrame()).toContain('1s')
  })

  it('clears its refresh interval on teardown', async () => {
    const ModalList = await loadModalList()
    const dialog = createDialogStub()
    const clock = new TestClock(0)

    const { renderer, renderOnce } = await testRender(
      () => (
        <ModalList
          Dialog={dialog.Dialog}
          rpc={{
            tasksList: async () => ({
              tasks: [makeTask('cpl_cleanup')],
            }),
          }}
          onClose={() => {}}
          clock={clock.adapter()}
        />
      ),
      { width: 120, height: 20, useThread: false },
    )

    await renderOnce()
    await waitForFrame({
      renderOnce,
      idle: () => renderer.idle(),
      captureCharFrame: () => String(clock.activeIntervalCount),
      includes: '1',
    })

    expect(clock.activeIntervalCount).toBe(1)

    renderer.destroy()

    expect(clock.activeIntervalCount).toBe(0)
    expect(clock.cleared).toHaveLength(1)
  })
})
