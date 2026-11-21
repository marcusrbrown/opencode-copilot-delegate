import { homedir, hostname } from 'node:os'
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

/**
 * Both sides join the discriminator into a path (`<base>/<discriminator>/
 * server-port.json`), so it must be a single path segment. The server checks
 * it before writing and the TUI client checks it before reading.
 */
export function assertSafeSessionDiscriminator(discriminator: string): void {
  if (
    discriminator.length === 0 ||
    discriminator === '.' ||
    discriminator === '..' ||
    discriminator.includes('/') ||
    discriminator.includes('\\')
  ) {
    throw new Error('invalid session discriminator')
  }
}

/**
 * The V2 TUI's port-file key for the server it is connected to, from
 * `client.server.info()`. Throws, with a message fit for the user, when the
 * server is not on this machine or did not report a usable pid.
 *
 * The port file is local, so a remote server (`--server <url>`) has none here,
 * and its pid could collide with an unrelated local one. `ServerInfo.hostname`
 * is the server machine's hostname; the client does not expose the URL it was
 * built with, and `urls` is the server's own view (loopback even when remote).
 * An absent hostname cannot prove the server is remote, so it is treated as
 * local.
 */
export function discriminatorForServer(
  info: { pid?: unknown; hostname?: unknown },
  localHostname: string = hostname(),
): string {
  if (
    typeof info.hostname === 'string' &&
    info.hostname.toLowerCase() !== localHostname.toLowerCase()
  ) {
    throw new Error(
      `status is only available for a local server (this server runs on ${info.hostname})`,
    )
  }

  const discriminator = serverPidDiscriminator(info.pid)

  if (discriminator === undefined) {
    throw new Error('the OpenCode server did not report a usable pid')
  }

  return discriminator
}
