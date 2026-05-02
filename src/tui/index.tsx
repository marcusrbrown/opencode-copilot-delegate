/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { ModalList } from './components/modal-list'
import { createRpcClient } from './rpc-client'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim()
  }

  return 'Unknown RPC error.'
}

const tui: TuiPlugin = async (api) => {
  const rpc = createRpcClient()
  const closeDialog = () => {
    api.ui.dialog.clear()
  }

  const showUnavailableAlert = (error: unknown) => {
    api.ui.dialog.setSize('medium')
    api.ui.dialog.replace(() => {
      return (
        <api.ui.DialogAlert
          title="Status unavailable."
          message={errorMessage(error)}
          onConfirm={closeDialog}
        />
      )
    }, closeDialog)
  }

  const openList = (initialTaskId?: string) => {
    api.ui.dialog.setSize('large')
    api.ui.dialog.replace(() => {
      return (
        <ModalList
          onClose={closeDialog}
          onLoadError={showUnavailableAlert}
          initialTaskId={initialTaskId}
          rpc={rpc}
        />
      )
    }, closeDialog)
  }

  const unregister = api.command.register(() => [
    {
      title: 'Copilot Status',
      value: '/copilot-status',
      slash: { name: 'copilot-status' },
      onSelect: () => {
        openList()
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    rpc.dispose()
    unregister()
  })
}

const id = 'opencode-copilot-delegate'

export default { id, tui } satisfies TuiPluginModule
