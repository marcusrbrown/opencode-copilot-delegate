import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { type Agent, discoverAgents } from '../src/discovery/agents'
import { buildDescription } from '../src/discovery/description'

const fixturesDir = join(import.meta.dir, 'fixtures', 'agents')
const userDir = join(fixturesDir, 'user')
const repoDir = join(fixturesDir, 'repo')

describe('discoverAgents', () => {
  describe('built-in agents', () => {
    it('should return built-in agents when no directories are provided', () => {
      // Given no user or repo agent directories
      // When discovering agents
      const agents = discoverAgents({})

      // Then only built-in agents are returned
      const builtins = agents.filter((a) => a.source === 'builtin')
      expect(builtins).toHaveLength(6)
      expect(builtins.map((a) => a.name)).toEqual([
        'default',
        'explore',
        'task',
        'general-purpose',
        'code-review',
        'research',
      ])
    })

    it('should mark all built-in agents with source "builtin"', () => {
      // Given no external directories
      // When discovering agents
      const agents = discoverAgents({})

      // Then every agent has source "builtin"
      for (const agent of agents) {
        expect(agent.source).toBe('builtin')
      }
    })
  })

  describe('user agents', () => {
    it('should include user agents from the user directory', () => {
      // Given a user agents directory with .md files
      // When discovering agents
      const agents = discoverAgents({ userAgentsDir: userDir })

      // Then user agents appear after built-ins
      const userAgents = agents.filter((a) => a.source === 'user')
      expect(userAgents.length).toBe(2)
      expect(userAgents.map((a) => a.name).sort()).toEqual([
        'custom-helper',
        'my-reviewer',
      ])
    })

    it('should place user agents after built-in agents', () => {
      // Given a user agents directory
      // When discovering agents
      const agents = discoverAgents({ userAgentsDir: userDir })

      // Then built-ins come first, then user agents
      const firstUserIndex = agents.findIndex((a) => a.source === 'user')
      const lastBuiltinIndex = agents.findLastIndex(
        (a) => a.source === 'builtin',
      )
      expect(firstUserIndex).toBeGreaterThan(lastBuiltinIndex)
    })
  })

  describe('repo agents', () => {
    it('should include repo agents from the repo directory', () => {
      // Given a repo agents directory with .md files
      // When discovering agents
      const agents = discoverAgents({ repoAgentsDir: repoDir })

      // Then repo agents appear after built-ins
      const repoAgents = agents.filter((a) => a.source === 'repo')
      expect(repoAgents.length).toBe(2)
      expect(repoAgents.map((a) => a.name).sort()).toEqual([
        'custom-helper',
        'project-bot',
      ])
    })
  })

  describe('merge and override behavior', () => {
    it('should merge built-in, user, and repo agents in order', () => {
      // Given both user and repo directories
      // When discovering agents
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      // Then agents appear in order: builtin, user, repo
      const sources = agents.map((a) => a.source)
      const firstUser = sources.indexOf('user')
      const firstRepo = sources.indexOf('repo')
      const lastBuiltin = sources.lastIndexOf('builtin')

      expect(lastBuiltin).toBeLessThan(firstUser)
      expect(firstUser).toBeLessThan(firstRepo)
    })

    it('should let repo agents override user agents with the same name', () => {
      // Given user has "custom-helper" and repo also has "custom-helper"
      // When discovering agents
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      // Then only one "custom-helper" exists, with source "repo"
      const customHelpers = agents.filter((a) => a.name === 'custom-helper')
      expect(customHelpers).toHaveLength(1)
      expect(customHelpers[0].source).toBe('repo')
    })

    it('should not override built-in agents with user or repo agents of the same name', () => {
      // Given user and repo dirs (neither contains a file named "default.md")
      // When discovering agents
      const agents = discoverAgents({
        userAgentsDir: userDir,
        repoAgentsDir: repoDir,
      })

      // Then built-in "default" remains
      const defaults = agents.filter((a) => a.name === 'default')
      expect(defaults).toHaveLength(1)
      expect(defaults[0].source).toBe('builtin')
    })
  })

  describe('missing directories', () => {
    it('should return only built-ins when user directory does not exist', () => {
      // Given a non-existent user directory
      // When discovering agents
      const agents = discoverAgents({
        userAgentsDir: '/tmp/nonexistent-user-agents-dir',
      })

      // Then only built-in agents are returned
      expect(agents).toHaveLength(6)
      expect(agents.every((a) => a.source === 'builtin')).toBe(true)
    })

    it('should return only built-ins when repo directory does not exist', () => {
      // Given a non-existent repo directory
      // When discovering agents
      const agents = discoverAgents({
        repoAgentsDir: '/tmp/nonexistent-repo-agents-dir',
      })

      // Then only built-in agents are returned
      expect(agents).toHaveLength(6)
    })

    it('should handle both directories missing gracefully', () => {
      // Given both directories are non-existent
      // When discovering agents
      const agents = discoverAgents({
        userAgentsDir: '/tmp/nope-user',
        repoAgentsDir: '/tmp/nope-repo',
      })

      // Then only built-in agents are returned, no errors thrown
      expect(agents).toHaveLength(6)
    })
  })
})

describe('buildDescription', () => {
  it('should format agents as a multi-line string', () => {
    // Given a list of agents
    const agents: Agent[] = [
      { name: 'default', source: 'builtin' },
      { name: 'explore', source: 'builtin' },
      { name: 'my-agent', source: 'user' },
    ]

    // When building the description
    const desc = buildDescription(agents)

    // Then it contains a header and formatted entries
    expect(desc).toContain('Available Copilot agents:')
    expect(desc).toContain('  - default (builtin)')
    expect(desc).toContain('  - explore (builtin)')
    expect(desc).toContain('  - my-agent (user)')
  })

  it('should list agents in the provided order', () => {
    // Given ordered agents
    const agents: Agent[] = [
      { name: 'default', source: 'builtin' },
      { name: 'custom', source: 'user' },
      { name: 'repo-bot', source: 'repo' },
    ]

    // When building the description
    const desc = buildDescription(agents)

    // Then lines appear in order
    const lines = desc.split('\n')
    const defaultIdx = lines.findIndex((l) => l.includes('default'))
    const customIdx = lines.findIndex((l) => l.includes('custom'))
    const repoBotIdx = lines.findIndex((l) => l.includes('repo-bot'))
    expect(defaultIdx).toBeLessThan(customIdx)
    expect(customIdx).toBeLessThan(repoBotIdx)
  })

  it('should cap at 20 entries and show truncation message', () => {
    // Given 25 agents
    const agents: Agent[] = Array.from({ length: 25 }, (_, i) => ({
      name: `agent-${String(i).padStart(2, '0')}`,
      source: 'builtin' as const,
    }))

    // When building the description
    const desc = buildDescription(agents)

    // Then only 20 are listed, with a truncation notice
    const agentLines = desc.split('\n').filter((l) => l.trim().startsWith('- '))
    expect(agentLines).toHaveLength(20)
    expect(desc).toContain(
      '... and 5 more (use copilot_list_agents to see all)',
    )
  })

  it('should not show truncation message for exactly 20 agents', () => {
    // Given exactly 20 agents
    const agents: Agent[] = Array.from({ length: 20 }, (_, i) => ({
      name: `agent-${i}`,
      source: 'builtin' as const,
    }))

    // When building the description
    const desc = buildDescription(agents)

    // Then no truncation message
    expect(desc).not.toContain('... and')
    expect(desc).not.toContain('more')
  })

  it('should handle an empty agent list', () => {
    // Given no agents
    const agents: Agent[] = []

    // When building the description
    const desc = buildDescription(agents)

    // Then it still has the header
    expect(desc).toContain('Available Copilot agents:')
    const agentLines = desc.split('\n').filter((l) => l.trim().startsWith('- '))
    expect(agentLines).toHaveLength(0)
  })
})
