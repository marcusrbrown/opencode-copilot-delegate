/**
 * Wires graceful shutdown for the RPC server.
 *
 * This helper is intentionally NOT exported from `src/index.ts`. Any named
 * export from the plugin entry is treated as a plugin factory by the OpenCode
 * loader and called with `undefined` input, which crashes plugin loading. The
 * same issue bit Systematic in v2.5.0 and v2.12.1. Moving helpers that are
 * only needed internally into `src/lib/` keeps the plugin entry's public
 * surface to `export default` only.
 *
 * Paired with `src/runtime/plugin-singleton.ts`: the singleton ensures the
 * RPC server starts exactly once per process; this helper ensures it shuts
 * down exactly once. Both constraints exist because the RPC server holds
 * exclusive process resources (a bound TCP port and a PID file entry) —
 * the same "exclusive resource" constraint that distinguishes this plugin
 * from Systematic's stateless plugins and justifies retaining the singleton
 * pattern after Systematic replaced it in PR #352
 * (https://github.com/marcusrbrown/systematic/pull/352).
 */

/**
 * Wraps a `closeRpcServer` callback so it runs at most once, and registers
 * `beforeExit` / `SIGTERM` handlers that trigger it automatically.
 *
 * Returns the idempotent `closeOnce` function so callers can also trigger
 * shutdown imperatively (e.g. in tests via `__captureRpcCleanup`).
 */
export function wireRpcServerCleanup(
  closeRpcServer: () => Promise<void>,
): () => Promise<void> {
  let closePromise: Promise<void> | undefined

  const closeOnce = (): Promise<void> => {
    if (!closePromise) {
      closePromise = closeRpcServer()
        .catch(() => {})
        .finally(() => {
          process.off('beforeExit', onBeforeExit)
          process.off('SIGTERM', onSigterm)
        })
    }

    return closePromise
  }

  const onBeforeExit = () => {
    void closeOnce()
  }

  const onSigterm = () => {
    void closeOnce().finally(() => {
      process.kill(process.pid, 'SIGTERM')
    })
  }

  // Both handlers use `process.once` so re-entrancy is impossible: even
  // if `beforeExit` fires repeatedly while `closeRpcServer()` is pending,
  // only the first invocation reaches `closeOnce`. The `.finally()` block
  // above still calls `process.off` for both as a belt-and-suspenders no-op
  // (cheap, removes the listener if it survived for any reason).
  process.once('beforeExit', onBeforeExit)
  process.once('SIGTERM', onSigterm)

  return closeOnce
}
