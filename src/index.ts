import { serverV1 } from './hosts/v1'
import { setupV2 } from './hosts/v2'

/**
 * Public type of the default export. It names no host package, so
 * `dist/index.d.ts` type-checks for consumers that have only one host's
 * package installed (both are optional peers). Hosts call the entries; the
 * parameters are `never` because nothing else should.
 */
interface DualHostPlugin {
  readonly id: string
  readonly server: (input: never) => Promise<unknown>
  readonly setup: (context: never) => Promise<unknown>
}

/**
 * Dual-host plugin entry. One default object, no named exports:
 * - OpenCode V1 (1.x) reads `server`.
 * - OpenCode V2 (2.x) reads `setup` and ignores `server`.
 *
 * Host packages are type-only imports, so `dist/index.js` loads on either
 * host without the other's package installed.
 */
const plugin: DualHostPlugin = {
  id: 'opencode-copilot-delegate',
  server: serverV1,
  setup: setupV2,
}

export default plugin
