import { spawn } from 'node:child_process'
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export interface ReapDeps {
  killProcessTree: (pid: number) => Promise<void>
  getPidComm: (pid: number) => Promise<string | null>
  getPidStartTime: (pid: number) => Promise<string | null>
  isPluginAlive: (pid: number) => boolean
}

export interface ReapResult {
  reaped: number
  skipped: number
  scannedFiles: number
  deletedFiles: number
}

export function defaultIsPluginAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

function psField(pid: number, field: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('ps', ['-p', String(pid), '-o', `${field}=`])
    let stdout = ''
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, 1000)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })

    child.on('close', (code) => {
      clearTimeout(timeout)
      if (timedOut || code !== 0) {
        resolve(null)
      } else {
        const trimmed = stdout.trim()
        resolve(trimmed || null)
      }
    })

    child.on('error', () => {
      clearTimeout(timeout)
      resolve(null)
    })
  })
}

export async function getPidComm(pid: number): Promise<string | null> {
  return psField(pid, 'comm')
}

export async function getPidStartTime(pid: number): Promise<string | null> {
  return psField(pid, 'lstart')
}

interface PidEntry {
  pid: number
  comm: string
  lstart: string
}

function parseLine(line: string): PidEntry | null {
  const parts = line.split('\t')
  if (parts.length !== 3) return null
  const pid = parseInt(parts[0], 10)
  if (Number.isNaN(pid)) return null
  return { pid, comm: parts[1], lstart: parts[2] }
}

async function processEntries(
  entries: PidEntry[],
  killProcessTree: ReapDeps['killProcessTree'],
  getPidComm: ReapDeps['getPidComm'],
  getPidStartTime: ReapDeps['getPidStartTime'],
): Promise<{ reaped: number; skipped: number }> {
  let reaped = 0
  let skipped = 0

  for (let i = 0; i < entries.length; i += 5) {
    const chunk = entries.slice(i, i + 5)
    const results = await Promise.all(
      chunk.map(async (entry) => {
        try {
          process.kill(entry.pid, 0)
        } catch {
          return { reaped: false, skipped: true }
        }

        const [liveComm, liveLstart] = await Promise.all([
          getPidComm(entry.pid),
          getPidStartTime(entry.pid),
        ])

        if (liveComm !== entry.comm || liveLstart !== entry.lstart) {
          return { reaped: false, skipped: true }
        }

        try {
          await killProcessTree(entry.pid)
          return { reaped: true, skipped: false }
        } catch {
          return { reaped: false, skipped: true }
        }
      }),
    )

    for (const r of results) {
      if (r.reaped) reaped++
      else if (r.skipped) skipped++
    }
  }

  return { reaped, skipped }
}

async function readPidFileEntries(
  filePath: string,
): Promise<PidEntry[] | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  const entries: PidEntry[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    const entry = parseLine(line)
    if (entry) entries.push(entry)
  }
  return entries
}

async function cleanupAfterReap(
  filePath: string,
  isCurrent: boolean,
  currentInstancePath: string,
): Promise<boolean> {
  try {
    if (isCurrent) {
      await writeFile(currentInstancePath, '')
      return false
    }
    await unlink(filePath)
    return true
  } catch {
    return false
  }
}

interface ReapFileOutcome {
  reaped: number
  skipped: number
  scanned: boolean
  deleted: boolean
}

async function reapOneFile(
  filePath: string,
  filePid: number,
  isCurrent: boolean,
  currentInstancePath: string,
  isPluginAlive: ReapDeps['isPluginAlive'],
  killProcessTree: ReapDeps['killProcessTree'],
  getPidComm: ReapDeps['getPidComm'],
  getPidStartTime: ReapDeps['getPidStartTime'],
): Promise<ReapFileOutcome> {
  const empty: ReapFileOutcome = {
    reaped: 0,
    skipped: 0,
    scanned: false,
    deleted: false,
  }

  if (!isCurrent && isPluginAlive(filePid)) {
    return empty
  }

  const entries = await readPidFileEntries(filePath)
  if (entries === null) {
    return empty
  }

  const { reaped, skipped } = await processEntries(
    entries,
    killProcessTree,
    getPidComm,
    getPidStartTime,
  )
  const deleted = await cleanupAfterReap(
    filePath,
    isCurrent,
    currentInstancePath,
  )
  return { reaped, skipped, scanned: true, deleted }
}

export async function reapOrphans(opts: {
  pidFileDir: string
  currentInstancePath: string
  killProcessTree: ReapDeps['killProcessTree']
  getPidComm: ReapDeps['getPidComm']
  getPidStartTime: ReapDeps['getPidStartTime']
  isPluginAlive?: ReapDeps['isPluginAlive']
}): Promise<ReapResult> {
  const {
    pidFileDir,
    currentInstancePath,
    killProcessTree,
    getPidComm,
    getPidStartTime,
    isPluginAlive = defaultIsPluginAlive,
  } = opts

  let files: string[]
  try {
    files = await readdir(pidFileDir)
  } catch {
    return { reaped: 0, skipped: 0, scannedFiles: 0, deletedFiles: 0 }
  }

  let reaped = 0
  let skipped = 0
  let scannedFiles = 0
  let deletedFiles = 0

  for (const file of files) {
    if (!file.endsWith('.pids')) continue

    const filePath = join(pidFileDir, file)
    const filePid = parseInt(basename(file, extname(file)), 10)

    if (Number.isNaN(filePid)) {
      console.warn(`[orphan-reaper] Skipping non-numeric PID file: ${file}`)
      continue
    }

    const outcome = await reapOneFile(
      filePath,
      filePid,
      filePid === process.pid,
      currentInstancePath,
      isPluginAlive,
      killProcessTree,
      getPidComm,
      getPidStartTime,
    )

    reaped += outcome.reaped
    skipped += outcome.skipped
    if (outcome.scanned) scannedFiles++
    if (outcome.deleted) deletedFiles++
  }

  return { reaped, skipped, scannedFiles, deletedFiles }
}
