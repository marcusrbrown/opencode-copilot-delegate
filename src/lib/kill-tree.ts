import fkill from 'fkill'
import { isErrnoException } from './errno'

function formatError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map((entry) => String(entry)).join('; ')
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function probeRootPid(
  pid: number,
):
  | { state: 'alive' }
  | { state: 'gone' }
  | { state: 'unknown'; code?: string } {
  // Probe the process group (-pid), not just the leader. fkill(-pid) targets
  // the whole group, so the question we actually want answered is "does the
  // group still have members?". Probing only the leader (process.kill(pid, 0))
  // would report ESRCH after a leader exit even if children remain, leading
  // us to suppress an error while children leak.
  try {
    process.kill(-pid, 0)
    return { state: 'alive' }
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return { state: 'gone' }
    }

    return {
      state: 'unknown',
      code: isErrnoException(error) ? error.code : undefined,
    }
  }
}

export async function killProcessTree(pid: number): Promise<void> {
  // Refuse pid <= 1: pid 0 means "caller's process group" and pid 1 is init.
  // Critically, fkill(-1) on Linux signals every process the caller has
  // permission to send to (POSIX semantics for kill(-1, sig)) — in a
  // container that is the entire container. The same concern applies if a
  // copilot subprocess legitimately runs as PID 1 (container entrypoint):
  // the orphan reaper's identity gate could pass and fkill(-1, ...) would
  // tear down the container. Treat PID 1 as unmanageable rather than risk
  // catastrophic blast radius.
  if (!Number.isFinite(pid) || pid <= 1) {
    return
  }

  const options = {
    force: false,
    forceAfterTimeout: 2000,
    waitForExit: 5000,
  }

  try {
    await fkill(-pid, options)
  } catch (error) {
    const probe = probeRootPid(pid)
    const failure = formatError(error)

    if (probe.state === 'gone') {
      console.warn(
        `[copilot-delegate] fkill failed for pid ${pid}, but root pid ${pid} is already gone; skipping follow-up kill handling (${failure})`,
      )
      return
    }

    if (probe.state === 'alive') {
      console.warn(
        `[copilot-delegate] fkill failed for pid ${pid}, and root pid ${pid} is still alive; processes may remain running (${failure})`,
      )
      throw error
    }

    console.warn(
      `[copilot-delegate] fkill failed for pid ${pid}, and root pid probe failed with ${probe.code ?? 'unknown error'}; process state is uncertain (${failure})`,
    )
    throw error
  }
}
