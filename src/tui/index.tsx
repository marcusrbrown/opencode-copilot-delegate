/** @jsxImportSource @opentui/solid */

import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { ConfirmCard } from './components/confirm-card'
import { ModalList } from './components/modal-list'
import type { ModalListTask } from './components/row'
import { createRpcClient } from './rpc-client'

const tui: TuiPlugin = async (api) => {
  const rpc = createRpcClient()
  const closeDialog = () => {
    api.ui.dialog.clear()
  }

  const openList = (initialTaskId?: string) => {
    api.ui.dialog.replace(() => {
      return (
        <ModalList
          Dialog={api.ui.Dialog}
          onClose={closeDialog}
          onCancelTask={openConfirmCard}
          initialTaskId={initialTaskId}
          rpc={rpc}
        />
      )
    }, closeDialog)
  }

  const openConfirmCard = (task: ModalListTask) => {
    api.ui.dialog.replace(() => {
      return (
        <ConfirmCard
          Dialog={api.ui.Dialog}
          task={task}
          rpc={rpc}
          onConfirm={() => openList(task.taskId)}
          onCancel={() => openList(task.taskId)}
          onDismissAfterError={() => openList(task.taskId)}
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

export default { tui } satisfies TuiPluginModule
