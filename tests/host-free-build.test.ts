import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Mirrors the server-entry options in scripts/build.ts. The built plugin
// entry must not import any OpenCode host package at runtime, so it loads on
// a host that doesn't provide that package, such as a V2-only install
// (docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md, R3).
const HOST_PACKAGES = ['@opencode-ai/plugin', '@opencode/plugin']

const outdir = await mkdtemp(join(tmpdir(), 'copilot-delegate-host-free-'))

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true })
})

describe('host-free server build', () => {
  test('bundles src/index.ts with no runtime host-package import', async () => {
    // Given the server entry built the way scripts/build.ts builds it
    const result = await Bun.build({
      entrypoints: ['src/index.ts'],
      outdir,
      target: 'node',
      external: HOST_PACKAGES,
    })
    expect(result.success).toBe(true)

    // Then the bundle references no host package specifier
    const bundle = await readFile(join(outdir, 'index.js'), 'utf8')
    for (const specifier of HOST_PACKAGES) {
      expect(bundle).not.toContain(`"${specifier}`)
      expect(bundle).not.toContain(`'${specifier}`)
    }
  })

  test('the bundle loads from a directory with no node_modules', async () => {
    // Given the bundle copied next to nothing but a module-type package.json
    await writeFile(join(outdir, 'package.json'), '{"type":"module"}\n')

    // When it is imported
    const mod = (await import(
      pathToFileURL(join(outdir, 'index.js')).href
    )) as Record<string, unknown>

    // Then it exposes only a default plugin factory
    expect(Object.keys(mod).sort()).toEqual(['default'])
    expect(typeof mod.default).toBe('function')
  })
})
