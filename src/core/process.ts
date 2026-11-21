import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { killProcessTree } from '../lib/kill-tree'
import { wireRpcServerCleanup } from '../lib/rpc-cleanup'
import { cancelTaskById } from '../runtime/cancel-helper'
import { getPidIdentity, reapOrphans } from '../runtime/orphan-reaper'
import {
  assertOrphansDirNotSymlink,
  assertPluginStateDirNotSymlink,
  resolveInstancePidFilePath,
  truncatePidFile,
} from '../runtime/pid-file'
import type { ProcessResources } from '../runtime/process-core'
import { startRpcServer } from '../runtime/rpc-server'
import { cleanupAll, getAllTasks, getTask } from '../runtime/task-registry'

/** Host-neutral log sink. Messages carry counts and paths, never tokens. */
export type LogSink = (level: 'info' | 'warn', message: string) => void

export interface InitializeProcessOptions {
  log: LogSink
  /** Test seam: receives the idempotent RPC close function. */
  onRpcCleanup?: (close: () => Promise<void>) => void
}

/**
 * Start one generation of process-wide resources: orphan reaping, then the
 * RPC server for the TUI. Reap and RPC failures are logged, not thrown, so
 * they can't block tool registration. Only an unresolvable state path (no
 * `XDG_STATE_HOME` and no home directory) rejects; `acquireProcessCore` then
 * drops the reference so the next activation retries. Callers go through
 * `acquireProcessCore`, which runs this at most once per live generation.
 *
 * The returned `teardown` applies the in-flight policy for a V2 release:
 * cancel running Copilot tasks, then close RPC (removing only this server's
 * port file), then truncate the PID ledger. V1 never calls it.
 */
export async function initializeProcess(
  options: InitializeProcessOptions,
): Promise<ProcessResources> {
  const { log } = options
  const pidFilePath = resolveInstancePidFilePath()
  const pidFileDir = dirname(pidFilePath)
  try {
    // mkdir is inside the try/catch so plugin init survives read-only
    // filesystems (EROFS) or permission-denied state dirs (EACCES). Both
    // failure modes degrade gracefully: reapOrphans's own readdir guard
    // returns an empty result when the directory cannot be enumerated.
    await assertPluginStateDirNotSymlink(pidFilePath)
    await mkdir(pidFileDir, { recursive: true, mode: 0o700 })
    await assertOrphansDirNotSymlink(pidFilePath)
    await reapOrphans({
      pidFileDir,
      currentInstancePath: pidFilePath,
      killProcessTree,
      getPidIdentity,
    })
  } catch {
    // mkdir or reap failure must not block plugin init.
  }

  // RPC/TUI status is additive. If localhost startup fails, the plugin must
  // still register its tools. The registry is process-wide, so this one
  // server lists and cancels tasks from every workspace.
  let closeRpc: (() => Promise<void>) | undefined
  try {
    const rpcServer = await startRpcServer({
      taskRegistry: { getAllTasks },
      cancelTaskById: (taskId) => cancelTaskById({ getTask }, taskId),
      log: (message) => log('info', message),
    })
    closeRpc = wireRpcServerCleanup(rpcServer.close)
    options.onRpcCleanup?.(closeRpc)
  } catch (error) {
    const message = `[copilot-delegate] failed to start RPC server: ${error}`
    console.warn(message)
    log('warn', message)
  }

  return {
    pidFilePath,
    teardown: async () => {
      await cleanupAll()
      await closeRpc?.()
      await truncatePidFile(pidFilePath).catch(() => {})
    },
  }
}
