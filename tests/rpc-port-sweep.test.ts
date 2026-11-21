import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PORT_FILE_GRACE_MS,
  sweepStalePortFiles,
} from '../src/runtime/rpc-port-sweep'
import { startRpcServer } from '../src/runtime/rpc-server'

const DEAD_PID = 999_001
const LIVE_PID = 999_002
const SECRET_TOKEN = 'super-secret-token-value-do-not-log'

// Fixed fake clock: files are stamped at FILE_TIME, "now" is injected.
const FILE_TIME_S = 1_700_000_000
const FILE_TIME_MS = FILE_TIME_S * 1000
const OLD_NOW = FILE_TIME_MS + DEFAULT_PORT_FILE_GRACE_MS + 1
const FRESH_NOW = FILE_TIME_MS + DEFAULT_PORT_FILE_GRACE_MS - 1

const tempPaths: string[] = []

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    rmSync(tempPath, { force: true, recursive: true })
  }
})

function makeBaseDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-port-sweep-'))
  tempPaths.push(dir)
  return dir
}

function seedPortFile(
  baseDir: string,
  discriminator: string,
  contents: string | Record<string, unknown>,
  mtimeS = FILE_TIME_S,
): string {
  const dir = join(baseDir, discriminator)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'server-port.json')
  writeFileSync(
    filePath,
    typeof contents === 'string' ? contents : JSON.stringify(contents),
  )
  utimesSync(filePath, mtimeS, mtimeS)
  return filePath
}

function portFileBody(pid: number): Record<string, unknown> {
  return { port: 41_234, pid, token: SECRET_TOKEN }
}

const isAlive = (pid: number) => pid === LIVE_PID

describe('sweepStalePortFiles', () => {
  it('removes an old dead-PID file and its emptied directory', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(join(baseDir, String(DEAD_PID)))).toBe(false)
    expect(result).toEqual({ scanned: 1, removed: 1, kept: 0 })
  })

  it('removes a dead-PID file under a non-numeric discriminator using the recorded PID', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(baseDir, 'ses_abc123', portFileBody(DEAD_PID))

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(false)
  })

  it('keeps a file whose PID is alive', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(LIVE_PID),
      portFileBody(LIVE_PID),
    )

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it('keeps a dead-PID file that is inside the grace window', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => FRESH_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(true)
  })

  it('honors an injected grace window', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => FILE_TIME_MS + 1_000,
      graceMs: 500,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(false)
  })

  it('keeps a non-numeric directory whose file records no PID', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(baseDir, 'ses_nopid', {
      port: 41_234,
      token: SECRET_TOKEN,
    })

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: () => false,
    })

    expect(existsSync(filePath)).toBe(true)
  })

  it('falls back to a numeric directory name when the file records no PID', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(baseDir, String(DEAD_PID), {
      port: 41_234,
      token: SECRET_TOKEN,
    })

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(filePath)).toBe(false)
  })

  it('keeps a file whose recorded PID disagrees with a numeric directory name', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID + 1),
    )

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: () => false,
    })

    expect(existsSync(filePath)).toBe(true)
  })

  it('never touches the current discriminator directory', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: String(DEAD_PID),
      now: () => OLD_NOW,
      isPidAlive: () => false,
    })

    expect(existsSync(filePath)).toBe(true)
    expect(result.scanned).toBe(0)
  })

  it('keeps garbage JSON, non-object JSON, and invalid PIDs without throwing', async () => {
    const baseDir = makeBaseDir()
    const files = [
      seedPortFile(baseDir, '111', '{not json'),
      seedPortFile(baseDir, '222', '[1,2,3]'),
      seedPortFile(baseDir, '333', 'null'),
      seedPortFile(baseDir, '444', { port: 1, pid: 'abc', token: 'x' }),
      seedPortFile(baseDir, '555', { port: 1, pid: -5, token: 'x' }),
    ]

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: () => false,
    })

    for (const filePath of files) {
      expect(existsSync(filePath)).toBe(true)
    }
    expect(result).toEqual({ scanned: 5, removed: 0, kept: 5 })
  })

  it('keeps entries that are not plain directories holding a regular file', async () => {
    const baseDir = makeBaseDir()
    // A directory sitting where the port file should be.
    const fileIsDir = join(baseDir, '777', 'server-port.json')
    mkdirSync(fileIsDir, { recursive: true })
    // A dangling symlink where the port file should be.
    const danglingDir = join(baseDir, '888')
    mkdirSync(danglingDir)
    symlinkSync(
      join(baseDir, 'does-not-exist'),
      join(danglingDir, 'server-port.json'),
    )
    // A symlinked discriminator directory must not be followed.
    const outsideBase = makeBaseDir()
    const outsideFile = seedPortFile(
      outsideBase,
      'target',
      portFileBody(DEAD_PID),
    )
    symlinkSync(join(outsideBase, 'target'), join(baseDir, '999'))

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: () => false,
    })

    expect(existsSync(fileIsDir)).toBe(true)
    expect(existsSync(danglingDir)).toBe(true)
    expect(existsSync(outsideFile)).toBe(true)
    expect(result).toEqual({ scanned: 3, removed: 0, kept: 3 })
  })

  it('does not throw when the base directory is missing', async () => {
    const baseDir = join(makeBaseDir(), 'missing')

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
    })

    expect(result).toEqual({ scanned: 0, removed: 0, kept: 0 })
  })

  it('keeps an entry and does not throw when the liveness probe throws', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: () => {
        throw new Error('probe exploded')
      },
    })

    expect(existsSync(filePath)).toBe(true)
    expect(result.kept).toBe(1)
  })

  it('bounds the number of entries examined per sweep', async () => {
    const baseDir = makeBaseDir()
    for (let i = 0; i < 5; i += 1) {
      seedPortFile(baseDir, String(DEAD_PID + i), portFileBody(DEAD_PID + i))
    }

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      maxEntries: 2,
      isPidAlive: () => false,
    })

    expect(result.scanned).toBe(2)
    expect(result.removed).toBe(2)
  })

  it('treats a live real process as alive with the default probe', async () => {
    const baseDir = makeBaseDir()
    const filePath = seedPortFile(
      baseDir,
      String(process.pid),
      portFileBody(process.pid),
    )

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
    })

    expect(existsSync(filePath)).toBe(true)
  })
})

describe('startRpcServer stale sweep', () => {
  it('removes stale siblings in the background but keeps its own port file', async () => {
    const baseDir = makeBaseDir()
    const stale = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )
    const live = seedPortFile(baseDir, String(LIVE_PID), portFileBody(LIVE_PID))
    const messages: string[] = []

    const server = await startRpcServer({
      taskRegistry: { getAllTasks: () => [] },
      cancelTaskById: () => ({ cancelled: false, error: 'no such task' }),
      portFileBaseDir: baseDir,
      sessionDiscriminator: 'current',
      log: (message) => messages.push(message),
      sweep: { now: () => OLD_NOW, isPidAlive: isAlive },
    })

    try {
      const result = await server.staleSweep

      expect(result.removed).toBe(1)
      expect(existsSync(stale)).toBe(false)
      expect(existsSync(live)).toBe(true)
      expect(existsSync(join(baseDir, 'current', 'server-port.json'))).toBe(
        true,
      )
      expect(messages).toEqual([
        '[copilot-delegate] removed 1 stale RPC port file(s) from exited sessions',
      ])
      // Counts only: no token, port, or path in any log call.
      for (const message of messages) {
        expect(message).not.toContain(SECRET_TOKEN)
        expect(message).not.toContain(server.token)
        expect(message).not.toContain(baseDir)
      }
    } finally {
      await server.close()
    }
  })

  it('never rejects server start when the sweep dependencies throw', async () => {
    const baseDir = makeBaseDir()
    const stale = seedPortFile(
      baseDir,
      String(DEAD_PID),
      portFileBody(DEAD_PID),
    )
    const messages: string[] = []

    const server = await startRpcServer({
      taskRegistry: { getAllTasks: () => [] },
      cancelTaskById: () => ({ cancelled: false, error: 'no such task' }),
      portFileBaseDir: baseDir,
      sessionDiscriminator: 'current',
      log: (message) => {
        messages.push(message)
        throw new Error('logger exploded')
      },
      sweep: {
        now: () => {
          throw new Error('clock exploded')
        },
        isPidAlive: () => {
          throw new Error('probe exploded')
        },
      },
    })

    try {
      await expect(server.staleSweep).resolves.toBeDefined()
      expect(existsSync(stale)).toBe(true)
      expect(existsSync(join(baseDir, 'current', 'server-port.json'))).toBe(
        true,
      )
    } finally {
      await server.close()
    }
  })

  it('swallows a throwing logger after a successful sweep', async () => {
    const baseDir = makeBaseDir()
    seedPortFile(baseDir, String(DEAD_PID), portFileBody(DEAD_PID))

    const server = await startRpcServer({
      taskRegistry: { getAllTasks: () => [] },
      cancelTaskById: () => ({ cancelled: false, error: 'no such task' }),
      portFileBaseDir: baseDir,
      sessionDiscriminator: 'current',
      log: () => {
        throw new Error('logger exploded')
      },
      sweep: { now: () => OLD_NOW, isPidAlive: isAlive },
    })

    try {
      await expect(server.staleSweep).resolves.toMatchObject({ removed: 1 })
    } finally {
      await server.close()
    }
  })
})

describe('sweepStalePortFiles: empty directories', () => {
  function seedEmptyDir(baseDir: string, name: string, mtimeS = FILE_TIME_S) {
    const dir = join(baseDir, name)
    mkdirSync(dir, { recursive: true })
    utimesSync(dir, mtimeS, mtimeS)
    return dir
  }

  it('removes an empty directory older than the grace window', async () => {
    const baseDir = makeBaseDir()
    const dir = seedEmptyDir(baseDir, String(DEAD_PID))

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(dir)).toBe(false)
    expect(result.removed).toBe(1)
  })

  it('keeps an empty directory inside the grace window', async () => {
    const baseDir = makeBaseDir()
    const dir = seedEmptyDir(baseDir, String(DEAD_PID))

    await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => FRESH_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(dir)).toBe(true)
  })

  it('keeps a directory that holds only a leftover temp file', async () => {
    const baseDir = makeBaseDir()
    const dir = seedEmptyDir(baseDir, String(DEAD_PID))
    writeFileSync(join(dir, 'server-port.json.tmp.abcd'), '{}')
    utimesSync(dir, FILE_TIME_S, FILE_TIME_S)

    const result = await sweepStalePortFiles({
      baseDir,
      currentDiscriminator: 'current',
      now: () => OLD_NOW,
      isPidAlive: isAlive,
    })

    expect(existsSync(dir)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it('makes progress past empty directories across starts under the entry cap', async () => {
    // Given three old empty dirs plus one stale dead-PID file: four removable
    // entries, one more than the cap (readdir order is filesystem-defined)
    const baseDir = makeBaseDir()
    const empties = ['100001', '100002', '100003'].map((name) =>
      seedEmptyDir(baseDir, name),
    )
    const stale = seedPortFile(baseDir, '999001', portFileBody(DEAD_PID))
    const sweep = () =>
      sweepStalePortFiles({
        baseDir,
        currentDiscriminator: 'current',
        now: () => OLD_NOW,
        isPidAlive: isAlive,
        maxEntries: 3,
      })

    // When two starts run
    const first = await sweep()
    const second = await sweep()

    // Then empty dirs never pin a slot: each start removes every entry it
    // examines, and everything is gone after two starts
    expect(first.removed).toBe(3)
    expect(second.removed).toBe(1)
    expect(existsSync(stale)).toBe(false)
    for (const dir of empties) expect(existsSync(dir)).toBe(false)
  })
})

describe('startRpcServer close', () => {
  it('removes its own port-file directory on close', async () => {
    const baseDir = makeBaseDir()
    const server = await startRpcServer({
      taskRegistry: { getAllTasks: () => [] },
      cancelTaskById: () => ({ cancelled: false, error: 'no such task' }),
      portFileBaseDir: baseDir,
      sessionDiscriminator: 'close-test',
      sweep: { now: () => OLD_NOW, isPidAlive: isAlive },
    })
    const sessionDir = join(baseDir, 'close-test')
    expect(existsSync(join(sessionDir, 'server-port.json'))).toBe(true)

    await server.close()

    expect(existsSync(sessionDir)).toBe(false)
  })
})
