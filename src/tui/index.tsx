/** @jsxImportSource @opentui/solid */

import type { Plugin } from '@opencode/plugin/tui'
import type { TuiPlugin, TuiPluginModule } from '@opencode-ai/plugin/tui'
import { discriminatorForServer } from '../runtime/rpc-paths'
import { createRpcClient } from './rpc-client'
import { createStatusDialogs } from './status-dialogs'
import { createStatusFlow } from './status-flow-v2'

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
      slashName?: string
      slashAliases?: ReadonlyArray<string>
      desc?: string
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
 * is logged. The TUI plugin still loads; only the slash command discovery
 * affordance is missing.
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
          slashName: 'copilot-status',
          desc: 'Show running Copilot delegations',
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
  const dialogs = createStatusDialogs(api, { rpc })

  const unregister = registerCopilotStatusCommand(api, () => {
    dialogs.openList()
  })

  api.lifecycle.onDispose(() => {
    dialogs.dispose()
    rpc.dispose()
    unregister()
  })
}

/**
 * OpenCode V2 entry. V2 calls `setup(ctx)` once per TUI process and awaits the
 * returned cleanup on deactivation.
 *
 * The V2 TUI is a different process from the server, with no
 * `OPENCODE_SESSION_ID`, so the server's port file is found by the server pid
 * that `ctx.client.server.info()` reports (see `serverPidDiscriminator`). It is
 * resolved per request, so a restarted managed service is picked up.
 *
 * `keymap.layer` registrations are removed by the host on deactivation; the
 * cleanup only stops this plugin's own work.
 */
const setup = async (ctx: Plugin.Context): Promise<Plugin.Cleanup> => {
  const rpc = createRpcClient({
    resolveSessionDiscriminator: async () => {
      return discriminatorForServer(await ctx.client.server.info())
    },
  })
  const flow = createStatusFlow(ctx.ui.dialog, { rpc })

  ctx.keymap.layer(() => ({
    // A layer defaults to the `base` input mode. Live check on 2.3.2: with the
    // default, the command was registered (`keymap.commands()` listed it) but
    // the prompt's `/` menu answered "No matching commands". `global` (what the
    // host's own slash commands use) makes it appear there and in the palette.
    mode: 'global',
    commands: [
      {
        id: 'copilot-status',
        title: 'Copilot Status',
        description: 'Show running Copilot delegations',
        group: 'Copilot',
        palette: true,
        slash: { name: 'copilot-status' },
        run() {
          flow.open()
        },
      },
    ],
  }))

  return () => {
    flow.dispose()
    rpc.dispose()
  }
}

const id = 'opencode-copilot-delegate'

/**
 * Dual-host TUI entry: V1 reads `tui`, V2 reads `setup`. V1's loader rejects a
 * default that carries both `server` and `tui`, but accepts extra keys such as
 * `setup`; this is the `./tui` entry, which never carries `server`.
 */
const plugin = { id, tui, setup }

plugin satisfies TuiPluginModule
plugin satisfies Plugin.Definition

export default plugin
