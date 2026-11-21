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
