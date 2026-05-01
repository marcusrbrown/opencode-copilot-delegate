/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginApi } from '@opencode-ai/plugin/tui'
import { createRpcClient } from './rpc-client'

type PlaceholderDialogProps = {
  api: TuiPluginApi
}

function PlaceholderDialog(props: PlaceholderDialogProps) {
  const Dialog = props.api.ui.Dialog

  return (
    <Dialog onClose={() => props.api.ui.dialog.clear()} size="medium">
      <box flexDirection="column" padding={1}>
        <text>Copilot status</text>
        <text>Unit 6 will load the live delegation list.</text>
      </box>
    </Dialog>
  )
}

const CopilotStatusTui: TuiPlugin = async (api) => {
  const rpc = createRpcClient()
  const closeDialog = () => {
    api.ui.dialog.clear()
  }
  const unregister = api.command.register(() => [
    {
      title: 'Copilot Status',
      value: '/copilot-status',
      slash: { name: 'copilot-status' },
      onSelect: () => {
        api.ui.dialog.replace(
          () => <PlaceholderDialog api={api} />,
          closeDialog,
        )
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    rpc.dispose()
    unregister()
  })
}

export default CopilotStatusTui
