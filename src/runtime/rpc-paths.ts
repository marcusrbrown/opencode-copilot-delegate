import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Shared by the RPC server and the TUI client so both resolve the same
 * `server-port.json` location. Node-only; `rpc-contract.ts` stays zod-only.
 */

export function defaultPortFileBaseDir(): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? homedir(), '.cache')

  return join(cacheHome, 'opencode', 'copilot-delegate')
}

export function defaultSessionDiscriminator(): string {
  return process.env.OPENCODE_SESSION_ID ?? String(process.pid)
}

/**
 * OpenCode V2 discriminator. The V2 TUI runs in a different process from the
 * server and has no `OPENCODE_SESSION_ID`, so the default above can never match
 * across the two. Instead the server keys its port file by its own pid
 * (`process.pid`), and the TUI reads that same number from the server it is
 * connected to (`ctx.client.server.info().pid`). One server process serves
 * every location and every TUI, so the pid is the natural identity.
 *
 * Returns `undefined` for anything that is not a positive safe integer so a
 * malformed server reply can never become a path segment.
 */
export function serverPidDiscriminator(pid: unknown): string | undefined {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0
    ? String(pid)
    : undefined
}
