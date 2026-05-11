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

/**
 * Register the `/copilot-status` command using whichever TUI API surface
 * the host OpenCode runtime exposes.
 *
 * OpenCode 1.14.42 removed `api.command.register` in favor of the new
 * keymap engine (`api.keymap.registerLayer`). 1.14.44+ restored
 * `api.command.register` as a deprecated shim that translates to
 * `keymap.registerLayer` internally. The dual-path helper below prefers
 * `keymap.registerLayer` when present (the canonical surface) and falls
 * back to `command.register` for hosts pinned at 1.14.41 or earlier.
 *
 * If neither surface is available, registration is a no-op and a warning
 * is logged. The TUI plugin still loads (dialog UI continues to work);
 * only the slash command discovery affordance is missing.
 *
 * Reference: Magic Context commit `5fe1c4f` on cortexkit/magic-context
 * established this dual-path pattern across the same upstream gap.
 */
function registerCopilotStatusCommand(
  api: Parameters<TuiPlugin>[0],
  openList: () => void,
): () => void {
  const apiAny = api as unknown as {
    keymap?: {
      registerLayer?: (layer: {
        commands: ReadonlyArray<Record<string, unknown>>
        bindings: ReadonlyArray<unknown>
      }) => () => void
    }
    command?: {
      register?: (
        cb: () => ReadonlyArray<Record<string, unknown>>,
      ) => () => void
    }
  }

  if (typeof apiAny.keymap?.registerLayer === 'function') {
    return apiAny.keymap.registerLayer({
      commands: [
        {
          namespace: 'palette',
          name: 'copilot-status',
          title: 'Copilot Status',
          category: 'Copilot',
          run() {
            openList()
          },
        },
      ],
      bindings: [],
    })
  }

  if (typeof apiAny.command?.register === 'function') {
    return apiAny.command.register(() => [
      {
        title: 'Copilot Status',
        value: '/copilot-status',
        slash: { name: 'copilot-status' },
        onSelect() {
          openList()
        },
      },
    ])
  }

  console.warn(
    '[opencode-copilot-delegate] No supported TUI command-registration API found (neither api.keymap.registerLayer nor api.command.register). The /copilot-status slash command will not be available, but the plugin remains loaded.',
  )
  return () => {}
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
    })
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
    })
  }

  const unregister = registerCopilotStatusCommand(api, () => {
    openList()
  })

  api.lifecycle.onDispose(() => {
    rpc.dispose()
    unregister()
  })
}

const id = 'opencode-copilot-delegate'

export default { id, tui } satisfies TuiPluginModule
