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
