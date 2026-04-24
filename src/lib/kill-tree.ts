import fkill from 'fkill'

export async function killProcessTree(pid: number): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return
  }

  const options = {
    force: false,
    forceAfterTimeout: 2000,
    waitForExit: 5000,
  }

  await fkill(-pid, options)
}
