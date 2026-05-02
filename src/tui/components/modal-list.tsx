/** @jsxImportSource @opentui/solid */

import {
  type BoxRenderable,
  TextAttributes,
  type TextRenderable,
} from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { onCleanup } from 'solid-js'
import type { RpcClient } from '../rpc-client'
import { formatRowText, type ModalListTask } from './row'

const LOADING_HEADER = 'Loading delegations…'
const EMPTY_STATE_TITLE = 'No Copilot delegations are running.'
const EMPTY_STATE_HINT =
  'Start one with the copilot_delegate tool, then reopen /copilot-status.'
export type ModalListClock = {
  now(): number
  setInterval(fn: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

type ModalListProps = {
  rpc: Pick<RpcClient, 'tasksList'>
  onClose: () => void
  onLoadError?: (error: unknown) => void
  initialTaskId?: string
  clock?: ModalListClock
}

type ViewState = { kind: 'loading' } | { kind: 'ready'; tasks: ModalListTask[] }

const defaultClock: ModalListClock = {
  now: () => Date.now(),
  setInterval: (fn, delayMs) => globalThis.setInterval(fn, delayMs),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

function updateText(
  node: TextRenderable | undefined,
  content: string,
  attributes = TextAttributes.NONE,
) {
  if (!node) {
    return
  }

  node.content = content
  node.attributes = attributes
}

function updateBoxVisibility(
  node: BoxRenderable | undefined,
  visible: boolean,
) {
  if (!node) {
    return
  }

  node.visible = visible
}

type ModalRefs = {
  headerText?: TextRenderable
  footerText?: TextRenderable
  emptyBox?: BoxRenderable
  emptyLineOne?: TextRenderable
  emptyLineTwo?: TextRenderable
  rowsBox?: BoxRenderable
  rowTexts: Array<TextRenderable | undefined>
}

function renderLoadingState(refs: ModalRefs) {
  updateText(refs.headerText, LOADING_HEADER)
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.emptyBox, false)
  updateBoxVisibility(refs.rowsBox, false)
}

function renderEmptyView(refs: ModalRefs) {
  updateText(refs.headerText, '0 running · 0 recent')
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.emptyBox, true)
  updateBoxVisibility(refs.rowsBox, false)
  updateText(refs.emptyLineOne, EMPTY_STATE_TITLE)
  updateText(refs.emptyLineTwo, EMPTY_STATE_HINT)
}

function renderTaskRows(
  refs: ModalRefs,
  tasks: ModalListTask[],
  nowMs: number,
) {
  updateText(refs.headerText, `${tasks.length} running · 0 recent`)
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.emptyBox, false)
  updateBoxVisibility(refs.rowsBox, true)

  for (const [index, rowText] of refs.rowTexts.entries()) {
    const task = tasks[index]

    if (!rowText) {
      continue
    }

    rowText.visible = task !== undefined
    rowText.content = task ? formatRowText(task, nowMs) : ''
    rowText.attributes = TextAttributes.NONE
  }
}

export function ModalList(props: ModalListProps) {
  const renderer = useRenderer()
  const clock = props.clock ?? defaultClock
  const now = { value: clock.now() }
  const state: { value: ViewState } = { value: { kind: 'loading' } }
  let disposed = false

  let headerText: TextRenderable | undefined
  let footerText: TextRenderable | undefined
  let emptyBox: BoxRenderable | undefined
  let emptyLineOne: TextRenderable | undefined
  let emptyLineTwo: TextRenderable | undefined
  let rowsBox: BoxRenderable | undefined
  const rowTexts: Array<TextRenderable | undefined> = []

  const refs = (): ModalRefs => ({
    headerText,
    footerText,
    emptyBox,
    emptyLineOne,
    emptyLineTwo,
    rowsBox,
    rowTexts,
  })

  const renderView = () => {
    if (disposed) {
      return
    }

    const currentState = state.value
    const currentRefs = refs()

    if (currentState.kind === 'loading') {
      renderLoadingState(currentRefs)
      renderer.requestRender()
      return
    }

    const tasks = currentState.tasks

    if (tasks.length === 0) {
      renderEmptyView(currentRefs)
      renderer.requestRender()
      return
    }

    renderTaskRows(currentRefs, tasks, now.value)

    renderer.requestRender()
  }

  const loadTasks = async () => {
    const response = await props.rpc.tasksList()

    if (disposed) {
      return
    }

    state.value = { kind: 'ready', tasks: response.tasks }

    renderView()
  }

  const intervalHandle = clock.setInterval(() => {
    now.value = clock.now()

    if (state.value.kind === 'ready' && state.value.tasks.length > 0) {
      renderView()
    }
  }, 1_000)

  void loadTasks().catch((error) => {
    if (disposed) {
      return
    }

    props.onLoadError?.(error)
  })

  onCleanup(() => {
    disposed = true
    clock.clearInterval(intervalHandle)
  })

  return (
    <box flexDirection="column" gap={1} padding={1} width="100%">
      <text ref={headerText}>Loading delegations…</text>

      <box
        ref={emptyBox}
        flexDirection="column"
        flexGrow={1}
        justifyContent="center"
        visible={false}
      >
        <text ref={emptyLineOne} />
        <text ref={emptyLineTwo} />
      </box>

      <box ref={rowsBox} flexDirection="column" flexGrow={1} visible={false}>
        <text ref={(node) => (rowTexts[0] = node)} />
        <text ref={(node) => (rowTexts[1] = node)} />
        <text ref={(node) => (rowTexts[2] = node)} />
        <text ref={(node) => (rowTexts[3] = node)} />
        <text ref={(node) => (rowTexts[4] = node)} />
        <text ref={(node) => (rowTexts[5] = node)} />
        <text ref={(node) => (rowTexts[6] = node)} />
        <text ref={(node) => (rowTexts[7] = node)} />
        <text ref={(node) => (rowTexts[8] = node)} />
        <text ref={(node) => (rowTexts[9] = node)} />
      </box>

      <text ref={footerText}>Esc close</text>
    </box>
  )
}

export default ModalList
