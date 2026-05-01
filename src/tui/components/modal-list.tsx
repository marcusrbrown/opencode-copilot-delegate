/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import {
  type BoxRenderable,
  type KeyEvent,
  TextAttributes,
  type TextRenderable,
} from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { onCleanup } from 'solid-js'
import type { RpcClient } from '../rpc-client'
import { EMPTY_STATE_HINT, EMPTY_STATE_TITLE } from './empty-state'
import { ERROR_STATE_HINT, ERROR_STATE_TITLE } from './error-state'
import { LOADING_HEADER } from './loading-state'
import { formatRowText, type ModalListTask } from './row'

export type ModalListClock = {
  now(): number
  setInterval(fn: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
}

type ModalListProps = {
  Dialog: TuiPluginApi['ui']['Dialog']
  rpc: Pick<RpcClient, 'tasksList'>
  onClose: () => void
  onCancelTask?: (task: ModalListTask) => void
  clock?: ModalListClock
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'ready'; tasks: ModalListTask[] }
  | { kind: 'error'; message: string }

const defaultClock: ModalListClock = {
  now: () => Date.now(),
  setInterval: (fn, delayMs) => globalThis.setInterval(fn, delayMs),
  clearInterval: (handle) => {
    globalThis.clearInterval(handle as ReturnType<typeof setInterval>)
  },
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return 'Unknown RPC error.'
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

function matchesKey(key: KeyEvent, expected: string): boolean {
  return (
    key.name === expected || key.sequence === expected || key.raw === expected
  )
}

type ModalRefs = {
  headerText?: TextRenderable
  footerText?: TextRenderable
  emptyBox?: BoxRenderable
  emptyLineOne?: TextRenderable
  emptyLineTwo?: TextRenderable
  errorBox?: BoxRenderable
  errorLineOne?: TextRenderable
  errorLineTwo?: TextRenderable
  errorLineThree?: TextRenderable
  rowsBox?: BoxRenderable
  rowTexts: Array<TextRenderable | undefined>
}

function renderLoadingState(refs: ModalRefs) {
  updateText(refs.headerText, LOADING_HEADER)
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.emptyBox, false)
  updateBoxVisibility(refs.errorBox, false)
  updateBoxVisibility(refs.rowsBox, false)
}

function renderErrorState(refs: ModalRefs, message: string) {
  updateText(refs.headerText, 'Status unavailable.')
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.emptyBox, false)
  updateBoxVisibility(refs.errorBox, true)
  updateBoxVisibility(refs.rowsBox, false)
  updateText(refs.errorLineOne, ERROR_STATE_TITLE)
  updateText(refs.errorLineTwo, message)
  updateText(refs.errorLineThree, ERROR_STATE_HINT)
}

function renderEmptyView(refs: ModalRefs) {
  updateText(refs.headerText, '0 running · 0 recent')
  updateText(refs.footerText, 'Esc close')
  updateBoxVisibility(refs.errorBox, false)
  updateBoxVisibility(refs.emptyBox, true)
  updateBoxVisibility(refs.rowsBox, false)
  updateText(refs.emptyLineOne, EMPTY_STATE_TITLE)
  updateText(refs.emptyLineTwo, EMPTY_STATE_HINT)
}

function renderTaskRows(
  refs: ModalRefs,
  tasks: ModalListTask[],
  focusedIndex: number,
  nowMs: number,
) {
  updateText(refs.headerText, `${tasks.length} running · 0 recent`)
  updateText(refs.footerText, '↑↓ navigate · c cancel · Esc close')
  updateBoxVisibility(refs.errorBox, false)
  updateBoxVisibility(refs.emptyBox, false)
  updateBoxVisibility(refs.rowsBox, true)

  for (const [index, rowText] of refs.rowTexts.entries()) {
    const task = tasks[index]

    if (!rowText) {
      continue
    }

    rowText.visible = task !== undefined
    rowText.content = task ? formatRowText(task, nowMs) : ''
    rowText.attributes =
      task && index === focusedIndex
        ? TextAttributes.INVERSE
        : TextAttributes.NONE
  }
}

function isReadyState(
  state: ViewState,
): state is Extract<ViewState, { kind: 'ready' }> {
  return state.kind === 'ready'
}

function previousIndex(current: number, total: number): number {
  return current === 0 ? total - 1 : current - 1
}

function nextIndex(current: number, total: number): number {
  return current === total - 1 ? 0 : current + 1
}

function isUpKey(key: KeyEvent): boolean {
  return matchesKey(key, 'up') || matchesKey(key, 'k')
}

function isDownKey(key: KeyEvent): boolean {
  return matchesKey(key, 'down') || matchesKey(key, 'j')
}

export function ModalList(props: ModalListProps) {
  const Dialog = props.Dialog
  const renderer = useRenderer()
  const clock = props.clock ?? defaultClock
  const now = { value: clock.now() }
  const state: { value: ViewState } = { value: { kind: 'loading' } }
  const focusedIndex = { value: 0 }

  let headerText: TextRenderable | undefined
  let footerText: TextRenderable | undefined
  let emptyBox: BoxRenderable | undefined
  let emptyLineOne: TextRenderable | undefined
  let emptyLineTwo: TextRenderable | undefined
  let errorBox: BoxRenderable | undefined
  let errorLineOne: TextRenderable | undefined
  let errorLineTwo: TextRenderable | undefined
  let errorLineThree: TextRenderable | undefined
  let rowsBox: BoxRenderable | undefined
  const rowTexts: Array<TextRenderable | undefined> = []

  const refs = (): ModalRefs => ({
    headerText,
    footerText,
    emptyBox,
    emptyLineOne,
    emptyLineTwo,
    errorBox,
    errorLineOne,
    errorLineTwo,
    errorLineThree,
    rowsBox,
    rowTexts,
  })

  const renderView = () => {
    const currentState = state.value
    const currentRefs = refs()

    if (currentState.kind === 'loading') {
      renderLoadingState(currentRefs)
      renderer.requestRender()
      return
    }

    if (currentState.kind === 'error') {
      renderErrorState(currentRefs, currentState.message)
      renderer.requestRender()
      return
    }

    const tasks = currentState.tasks

    if (tasks.length === 0) {
      renderEmptyView(currentRefs)
      renderer.requestRender()
      return
    }

    renderTaskRows(currentRefs, tasks, focusedIndex.value, now.value)

    renderer.requestRender()
  }

  const loadTasks = async () => {
    try {
      const response = await props.rpc.tasksList()
      state.value = { kind: 'ready', tasks: response.tasks }
    } catch (error) {
      state.value = { kind: 'error', message: errorMessage(error) }
    }

    renderView()
  }

  const intervalHandle = clock.setInterval(() => {
    now.value = clock.now()

    if (state.value.kind === 'ready' && state.value.tasks.length > 0) {
      renderView()
    }
  }, 1_000)

  void loadTasks()

  const handleKeyPress = (key: KeyEvent) => {
    if (matchesKey(key, 'escape')) {
      key.preventDefault()
      props.onClose()
      return
    }

    if (!isReadyState(state.value) || state.value.tasks.length === 0) {
      return
    }

    if (isUpKey(key)) {
      key.preventDefault()
      focusedIndex.value = previousIndex(
        focusedIndex.value,
        state.value.tasks.length,
      )
      renderView()
      return
    }

    if (isDownKey(key)) {
      key.preventDefault()
      focusedIndex.value = nextIndex(
        focusedIndex.value,
        state.value.tasks.length,
      )
      renderView()
      return
    }

    if (matchesKey(key, 'c')) {
      key.preventDefault()
      props.onCancelTask?.(state.value.tasks[focusedIndex.value])
    }
  }

  renderer.keyInput.on('keypress', handleKeyPress)

  onCleanup(() => {
    renderer.keyInput.off('keypress', handleKeyPress)
    clock.clearInterval(intervalHandle)
  })

  return (
    <Dialog onClose={props.onClose} size="medium">
      <box flexDirection="column" gap={1} padding={1}>
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

        <box
          ref={errorBox}
          flexDirection="column"
          flexGrow={1}
          justifyContent="center"
          visible={false}
        >
          <text ref={errorLineOne} />
          <text ref={errorLineTwo} />
          <text ref={errorLineThree} />
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
    </Dialog>
  )
}

export default ModalList
