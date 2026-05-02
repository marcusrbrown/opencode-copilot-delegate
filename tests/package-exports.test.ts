import { beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

type PackageJson = {
  exports: {
    './tui': {
      types: string
      import: string
    }
  }
}

describe('package exports', () => {
  beforeAll(async () => {
    const build = Bun.spawn(['bun', 'run', 'build'], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    const exitCode = await build.exited

    if (exitCode !== 0) {
      throw new Error(await new Response(build.stderr).text())
    }
  })

  it('exports the TUI entrypoint from built JavaScript and declarations', () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as PackageJson
    const tuiExport = packageJson.exports['./tui']

    expect(tuiExport).toEqual({
      types: './dist/tui/index.d.ts',
      import: './dist/tui/index.js',
    })
    expect(existsSync(join(process.cwd(), tuiExport.import))).toBe(true)
    expect(existsSync(join(process.cwd(), tuiExport.types))).toBe(true)
  })
})
