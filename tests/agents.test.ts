import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { type Agent, discoverAgents } from '../src/discovery/agents'
import { buildDescription } from '../src/discovery/description'

const fixturesDir = join(import.meta.dir, 'fixtures', 'agents')
const userDir = join(fixturesDir, 'user')
const repoDir = join(fixturesDir, 'repo')

describe('discoverAgents', () => {
  describe('empty discovery', () => {
    it('should return an empty list when no directories are provided', () => {
      const agents = discoverAgents({})
      expect(agents).toEqual([])
    })

    it('should return an empty list when both directories are missing', () => {
      const agents = discoverAgents({
        userAgentsDir: '/tmp/nope-user',
        repoAgentsDir: '/tmp/nope-repo',
      })
      expect(agents).toEqual([])
    })
  })

  describe('user agents', () => {
    it('should include user agents from the user directory', () => {
      const agents = discoverAgents({ userAgentsDir: userDir })

      const userAgents = agents.filter((a) => a.source === 'user')
      expect(userAgents.length).toBe(3)
      expect(userAgents.map((a) => a.name).sort()).toEqual([
        'custom-helper',
        'default',
        'my-reviewer',
      ])
    })

    it('should return an empty list when only a missing user dir is given', () => {
      const agents = discoverAgents({
        userAgentsDir: '/tmp/nonexistent-user-agents-dir',
      })
      expect(agents).toEqual([])
    })
  })

  describe('repo agents', () => {
    it('should include repo agents from the repo directory', () => {
      const agents = discoverAgents({ repoAgentsDir: repoDir })

      const repoAgents = agents.filter((a) => a.source === 'repo')
      expect(repoAgents.length).toBe(3)
      expect(repoAgents.map((a) => a.name).sort()).toEqual([
        'custom-helper',
        'default',
        'project-bot',
      ])
    })

    it('should return an empty list when only a missing repo dir is given', () => {
      const agents = discoverAgents({
        repoAgentsDir: '/tmp/nonexistent-repo-agents-dir',
      })
      expect(agents).toEqual([])
    })
  })

  describe('merge and override behavior', () => {
    it('should merge user and repo agents with user appearing before repo', () => {
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      const sources = agents.map((a) => a.source)
      const firstUser = sources.indexOf('user')
      const firstRepo = sources.indexOf('repo')
      expect(firstUser).toBeGreaterThanOrEqual(0)
      expect(firstRepo).toBeGreaterThanOrEqual(0)
      expect(firstUser).toBeLessThan(firstRepo)
    })

    it('should let repo agents override user agents with the same name', () => {
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      const customHelpers = agents.filter((a) => a.name === 'custom-helper')
      expect(customHelpers).toHaveLength(1)
      expect(customHelpers[0].source).toBe('repo')
    })

    it('should keep colliding user/repo `default` entries with repo winning', () => {
      // The fixtures include a `default.md` in both user and repo dirs to
      // verify the override behavior survives the BUILTIN_AGENTS removal.
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      const defaults = agents.filter((a) => a.name === 'default')
      expect(defaults).toHaveLength(1)
      expect(defaults[0].source).toBe('repo')

      // Total: user(my-reviewer) + repo(custom-helper, default, project-bot) = 4
      expect(agents).toHaveLength(4)
    })
  })
})

describe('buildDescription', () => {
  it('should produce an empty-list message when no agents are discovered', () => {
    const desc = buildDescription([])
    expect(desc).toContain('No Copilot agents discovered.')
    expect(desc).toContain('~/.copilot/agents')
    expect(desc).toContain('.github/agents')
  })

  it('should format discovered agents as a multi-line string', () => {
    const agents: Agent[] = [
      { name: 'custom-helper', source: 'user' },
      { name: 'my-reviewer', source: 'user' },
      { name: 'project-bot', source: 'repo' },
    ]

    const desc = buildDescription(agents)

    expect(desc).toContain('Available Copilot agents:')
    expect(desc).toContain('  - custom-helper (user)')
    expect(desc).toContain('  - my-reviewer (user)')
    expect(desc).toContain('  - project-bot (repo)')
  })

  it('should list agents in the provided order', () => {
    const agents: Agent[] = [
      { name: 'a-user', source: 'user' },
      { name: 'b-user', source: 'user' },
      { name: 'c-repo', source: 'repo' },
    ]

    const desc = buildDescription(agents)

    const lines = desc.split('\n')
    const aIdx = lines.findIndex((l) => l.includes('a-user'))
    const bIdx = lines.findIndex((l) => l.includes('b-user'))
    const cIdx = lines.findIndex((l) => l.includes('c-repo'))
    expect(aIdx).toBeLessThan(bIdx)
    expect(bIdx).toBeLessThan(cIdx)
  })

  it('should cap at 20 entries and show a truncation count', () => {
    const agents: Agent[] = Array.from({ length: 25 }, (_, i) => ({
      name: `agent-${String(i).padStart(2, '0')}`,
      source: 'user' as const,
    }))

    const desc = buildDescription(agents)

    const agentLines = desc.split('\n').filter((l) => l.trim().startsWith('- '))
    expect(agentLines).toHaveLength(20)
    expect(desc).toContain(
      '... and 5 more (see ~/.copilot/agents or .github/agents)',
    )
  })

  it('should not show truncation message for exactly 20 agents', () => {
    const agents: Agent[] = Array.from({ length: 20 }, (_, i) => ({
      name: `agent-${i}`,
      source: 'user' as const,
    }))

    const desc = buildDescription(agents)

    expect(desc).not.toContain('... and')
    expect(desc).not.toContain('more (see')
  })
})
