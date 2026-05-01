/** @jsxImportSource @opentui/solid */

import type { TuiPlugin } from '@opencode-ai/plugin/tui'
import { ModalList } from './components/modal-list'
import { createRpcClient } from './rpc-client'

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
        api.ui.dialog.replace(() => {
          return (
            <ModalList Dialog={api.ui.Dialog} onClose={closeDialog} rpc={rpc} />
          )
        }, closeDialog)
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    rpc.dispose()
    unregister()
  })
}

export default CopilotStatusTui
