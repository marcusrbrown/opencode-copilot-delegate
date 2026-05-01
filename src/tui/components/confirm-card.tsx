/** @jsxImportSource @opentui/solid */

import type { TuiPluginApi } from '@opencode-ai/plugin/tui'
import {
  type KeyEvent,
  TextAttributes,
  type TextRenderable,
} from '@opentui/core'
import { useRenderer } from '@opentui/solid'
import { onCleanup } from 'solid-js'
import type { RpcClient } from '../rpc-client'
import type { ModalListTask } from './row'

type ConfirmCardProps = {
  Dialog: TuiPluginApi['ui']['Dialog']
  task: ModalListTask
  rpc: Pick<RpcClient, 'tasksCancel'>
  onConfirm: () => void
  onCancel: () => void
  onDismissAfterError: () => void
}

type ConfirmState =
  | {
      kind: 'confirm'
      focusedAction: 'confirm' | 'cancel'
      busy: boolean
    }
  | {
      kind: 'error'
      message: string
    }

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return 'Unknown RPC error.'
}

function matchesKey(key: KeyEvent, expected: string): boolean {
  return (
    key.name === expected || key.sequence === expected || key.raw === expected
  )
}

function isActivateKey(key: KeyEvent): boolean {
  return (
    matchesKey(key, 'return') ||
    matchesKey(key, 'enter') ||
    matchesKey(key, 'space') ||
    key.sequence === ' ' ||
    key.raw === ' '
  )
}

function isLeftKey(key: KeyEvent): boolean {
  return matchesKey(key, 'left')
}

function isRightKey(key: KeyEvent): boolean {
  return matchesKey(key, 'right')
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
  node.visible = content.length > 0
}

export function ConfirmCard(props: ConfirmCardProps) {
  const Dialog = props.Dialog
  const renderer = useRenderer()
  const title = `Cancel Copilot delegation ${props.task.taskId}?`
  const state: { value: ConfirmState } = {
    value: {
      kind: 'confirm',
      focusedAction: 'confirm',
      busy: false,
    },
  }

  let confirmText: TextRenderable | undefined
  let cancelText: TextRenderable | undefined
  let errorText: TextRenderable | undefined
  let dismissText: TextRenderable | undefined

  const renderView = () => {
    const currentState = state.value

    if (currentState.kind === 'error') {
      updateText(confirmText, '')
      updateText(cancelText, '')
      updateText(errorText, `Cancel failed: ${currentState.message}`)
      updateText(dismissText, 'Dismiss', TextAttributes.INVERSE)
      renderer.requestRender()
      return
    }

    updateText(
      confirmText,
      'Cancel Task',
      currentState.focusedAction === 'confirm'
        ? TextAttributes.INVERSE
        : TextAttributes.NONE,
    )
    updateText(
      cancelText,
      'Keep Running',
      currentState.focusedAction === 'cancel'
        ? TextAttributes.INVERSE
        : TextAttributes.NONE,
    )
    updateText(errorText, '')
    updateText(dismissText, '')
    renderer.requestRender()
  }

  const closeToList = () => {
    if (state.value.kind === 'error') {
      props.onDismissAfterError()
      return
    }

    if (state.value.busy) {
      return
    }

    props.onCancel()
  }

  const confirmCancel = async () => {
    if (state.value.kind !== 'confirm' || state.value.busy) {
      return
    }

    state.value = { ...state.value, busy: true }

    try {
      const response = await props.rpc.tasksCancel(props.task.taskId)

      if (response.cancelled) {
        props.onConfirm()
        return
      }

      state.value = {
        kind: 'error',
        message: response.error ?? 'Unknown RPC error.',
      }
    } catch (error) {
      state.value = { kind: 'error', message: errorMessage(error) }
    }

    renderView()
  }

  const activateFocusedAction = () => {
    if (state.value.kind === 'error') {
      props.onDismissAfterError()
      return
    }

    if (state.value.focusedAction === 'confirm') {
      void confirmCancel()
      return
    }

    props.onCancel()
  }

  const focusConfirm = () => {
    if (state.value.kind !== 'confirm' || state.value.busy) {
      return
    }

    state.value = { ...state.value, focusedAction: 'confirm' }
    renderView()
  }

  const focusCancel = () => {
    if (state.value.kind !== 'confirm' || state.value.busy) {
      return
    }

    state.value = { ...state.value, focusedAction: 'cancel' }
    renderView()
  }

  const handleKeyPress = (key: KeyEvent) => {
    if (matchesKey(key, 'escape')) {
      key.preventDefault()
      closeToList()
      return
    }

    if (state.value.kind === 'confirm' && !state.value.busy) {
      if (isLeftKey(key)) {
        key.preventDefault()
        focusConfirm()
        return
      }

      if (isRightKey(key)) {
        key.preventDefault()
        focusCancel()
        return
      }
    }

    if (isActivateKey(key)) {
      key.preventDefault()
      activateFocusedAction()
    }
  }

  renderer.keyInput.on('keypress', handleKeyPress)

  onCleanup(() => {
    renderer.keyInput.off('keypress', handleKeyPress)
  })

  return (
    <Dialog onClose={closeToList} size="medium">
      <box flexDirection="column" gap={1} padding={1}>
        <text>{title}</text>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text nodes handle terminal mouse events directly. */}
        <text
          ref={confirmText}
          attributes={TextAttributes.INVERSE}
          onMouseUp={() => {
            focusConfirm()
            void confirmCancel()
          }}
        >
          Cancel Task
        </text>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text nodes handle terminal mouse events directly. */}
        <text
          ref={cancelText}
          onMouseUp={() => {
            focusCancel()
            props.onCancel()
          }}
        >
          Keep Running
        </text>
        <text ref={errorText} visible={false} />
        {/* biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI text nodes handle terminal mouse events directly. */}
        <text
          ref={dismissText}
          visible={false}
          onMouseUp={() => {
            props.onDismissAfterError()
          }}
        />
      </box>
    </Dialog>
  )
}

export default ConfirmCard
