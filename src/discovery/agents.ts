import { readdirSync } from 'node:fs'
import { basename } from 'node:path'

export interface Agent {
  name: string
  source: 'builtin' | 'user' | 'repo'
}

const BUILTIN_AGENTS: readonly string[] = [
  'default',
  'explore',
  'task',
  'general-purpose',
  'code-review',
  'research',
]

interface DiscoverOptions {
  userAgentsDir?: string
  repoAgentsDir?: string
}

function scanDir(dir: string, source: 'user' | 'repo'): Agent[] {
  try {
    const entries = readdirSync(dir)
    return entries
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({
        name: basename(f, '.md'),
        source,
      }))
  } catch {
    return []
  }
}

export function discoverAgents(opts: DiscoverOptions): Agent[] {
  const builtins: Agent[] = BUILTIN_AGENTS.map((name) => ({
    name,
    source: 'builtin',
  }))

  const userAgents = opts.userAgentsDir
    ? scanDir(opts.userAgentsDir, 'user')
    : []

  const repoAgents = opts.repoAgentsDir
    ? scanDir(opts.repoAgentsDir, 'repo')
    : []

  // Repo overrides user with same name; builtins are never overridden
  const builtinNames = new Set(BUILTIN_AGENTS)
  const overriddenNames = new Set(repoAgents.map((a) => a.name))
  const filteredUser = userAgents
    .filter((a) => !builtinNames.has(a.name))
    .filter((a) => !overriddenNames.has(a.name))
  const filteredRepo = repoAgents.filter((a) => !builtinNames.has(a.name))

  return [...builtins, ...filteredUser, ...filteredRepo]
}
