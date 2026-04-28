import fkill from 'fkill'

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

  await fkill(-pid, options)
}
