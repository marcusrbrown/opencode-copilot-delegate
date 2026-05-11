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
 * Narrow structural interface for `api.keymap.registerLayer`. Mirrors the
 * shape exposed by `@opencode-ai/plugin/tui`'s `TuiKeymap` (which aliases
 * `Keymap<Renderable, KeyEvent>` from `@opentui/keymap`). That upstream
 * type is not exported through `@opencode-ai/plugin`'s public surface and
 * `@opentui/keymap` is not a direct dependency here, so we declare the
 * minimum contract needed for the dual-path registration to type-check
 * without reaching into private OpenTUI types.
 */
interface KeymapRegisterLayerHost {
  registerLayer: (layer: {
    commands: ReadonlyArray<{
      namespace: string
      name: string
      title: string
      category: string
      run: () => void
    }>
    bindings: ReadonlyArray<unknown>
  }) => () => void
}

function hasKeymapRegisterLayer(
  api: Parameters<TuiPlugin>[0],
): api is Parameters<TuiPlugin>[0] & { keymap: KeymapRegisterLayerHost } {
  const candidate = (api as { keymap?: { registerLayer?: unknown } }).keymap
  return candidate != null && typeof candidate.registerLayer === 'function'
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
  if (hasKeymapRegisterLayer(api)) {
    return api.keymap.registerLayer({
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

  if (typeof api.command?.register === 'function') {
    return api.command.register(() => [
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

  // Plugin-level logs normally go through `client.app.log`, but the TUI
  // half has no equivalent structured channel — `console.warn` is the
  // only practical option. Surfaces in dev/debug consoles; in production
  // the message is purely defensive (it only fires when the host runtime
  // exposes neither registration surface, which should never happen).
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
