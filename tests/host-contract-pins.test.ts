import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

// Keeps the CI host-contract matrix honest: the pins file, the workflow
// matrix and the package peer/dev ranges must agree
// (docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md, Unit 5).

type Pin = { id: string; host: 'v1' | 'v2'; package: string; version: string }

const pinsFile = JSON.parse(
  await readFile('scripts/opencode-host-pins.json', 'utf8'),
) as { pins: Pin[] }
const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
  peerDependencies: Record<string, string>
  devDependencies: Record<string, string>
}
const workflow = Bun.YAML.parse(
  await readFile('.github/workflows/ci.yaml', 'utf8'),
) as {
  jobs: Record<
    string,
    { name: string; strategy?: { matrix: { pin: string[] } } }
  >
}
const settings = Bun.YAML.parse(
  await readFile('.github/settings.yml', 'utf8'),
) as {
  branches: {
    protection: { required_status_checks: { contexts: string[] } }
  }[]
}

const pin = (id: string) => {
  const found = pinsFile.pins.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`missing pin ${id}`)
  return found
}

describe('host-contract path filter', () => {
  // The `changes` job's grep -E pattern, read from the workflow so the test
  // can't drift from what CI runs. POSIX ERE here is also valid JS RegExp.
  const changesStep = (
    workflow.jobs.changes as unknown as { steps: { run?: string }[] }
  ).steps.find((step) => step.run?.includes('pattern='))
  const match = changesStep?.run?.match(/pattern='([^']+)'/)
  const filter = new RegExp(match?.[1] ?? '(?!)')

  test.each([
    'src/hosts/v2.ts',
    'scripts/build.ts',
    'tests/host-contract/run-host.sh',
    'tests/fixtures/happy-path.jsonl',
    'package.json',
    'bun.lock',
    'tsconfig.json',
    'mise.toml',
    '.github/workflows/ci.yaml',
  ])('runs the matrix when %s changes', (path) => {
    expect(filter.test(path)).toBe(true)
  })

  test.each([
    'README.md',
    'docs/plans/x.md',
    'tests/notify.test.ts',
    '.github/settings.yml',
    'src.md',
  ])('skips the matrix when only %s changes', (path) => {
    expect(filter.test(path)).toBe(false)
  })
})

describe('opencode host pins', () => {
  test('the CI matrix runs exactly the pins in the pins file', () => {
    expect(
      [...(workflow.jobs['host-contract'].strategy?.matrix.pin ?? [])].sort(),
    ).toEqual(pinsFile.pins.map((candidate) => candidate.id).sort())
  })

  test('the V1 floor pin is the @opencode-ai/plugin peer floor', () => {
    expect(pkg.peerDependencies['@opencode-ai/plugin']).toBe(
      `>=${pin('v1-floor').version}`,
    )
  })

  test('the V1 current and V2 pins match the type-only devDependencies', () => {
    expect(pkg.devDependencies['@opencode-ai/plugin']).toBe(
      pin('v1-current').version,
    )
    expect(pkg.devDependencies['@opencode/plugin']).toBe(pin('v2').version)
  })

  test('each pin names the host package for its major', () => {
    expect(pin('v1-floor').package).toBe('opencode-ai')
    expect(pin('v1-current').package).toBe('opencode-ai')
    expect(pin('v2').package).toBe('@opencode/cli')
  })

  test('the aggregator is a required status check', () => {
    const aggregator = workflow.jobs['host-contract-result'].name
    const contexts =
      settings.branches[0].protection.required_status_checks.contexts
    expect(contexts).toContain(aggregator)
  })
})

// Inputs for the OpenTUI sync check below.
const v2Peers = (
  JSON.parse(
    await readFile('node_modules/@opencode/plugin/package.json', 'utf8'),
  ) as { peerDependencies: Record<string, string> }
).peerDependencies
const renovate = Bun.JSON5.parse(
  await readFile('.github/renovate.json5', 'utf8'),
) as {
  packageRules: { matchPackageNames?: string[]; allowedVersions?: string }[]
}
const pkgFull = JSON.parse(await readFile('package.json', 'utf8')) as {
  devDependencies: Record<string, string>
  overrides: Record<string, string>
}

describe('OpenTUI dev pin follows the V2 host', () => {
  // The @opentui dev pin only types and tests the TUI (both hosts load their
  // own copy), so it must be the lowest version both hosts' peers accept:
  // the V2 host package's floor. Renovate's allowedVersions cap and the
  // @opentui/core override must move with it (.github/renovate.json5).
  test.each(['@opentui/core', '@opentui/solid'])(
    '%s dev pin equals the V2 host floor and the Renovate cap',
    (name) => {
      const floor = v2Peers[name]?.replace(/^>=/, '')
      expect(floor).toMatch(/^\d+\.\d+\.\d+$/)
      expect(pkgFull.devDependencies[name]).toBe(floor)
      const rule = renovate.packageRules.find((r) =>
        r.matchPackageNames?.includes(name),
      )
      expect(rule?.allowedVersions).toBe(`<=${floor}`)
    },
  )

  test('the @opentui/core override matches the dev pin', () => {
    expect(pkgFull.overrides['@opentui/core']).toBe(
      pkgFull.devDependencies['@opentui/core'],
    )
  })
})
