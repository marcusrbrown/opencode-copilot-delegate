import { readdirSync } from 'node:fs'
import { basename } from 'node:path'

export interface Agent {
  name: string
  source: 'user' | 'repo'
}

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

/**
 * Discover Copilot agents from the user and repo agent directories.
 *
 * Copilot CLI v1.0.36 ships zero built-in agents. Every `--agent <name>`
 * argument must resolve to a discoverable `<name>.md` file in one of the
 * standard agent directories (`~/.copilot/agents`, `.github/agents`, or
 * `~/.copilot/installed-plugins/<plugin>/agents`). The plugin discovers the
 * first two; bundled-with-plugin agents are out of scope for this discovery
 * helper.
 *
 * Repo agents override user agents with the same name; the repo entry wins.
 */
export function discoverAgents(opts: DiscoverOptions): Agent[] {
  const userAgents = opts.userAgentsDir
    ? scanDir(opts.userAgentsDir, 'user')
    : []

  const repoAgents = opts.repoAgentsDir
    ? scanDir(opts.repoAgentsDir, 'repo')
    : []

  // Repo overrides user with same name.
  const overriddenNames = new Set(repoAgents.map((a) => a.name))
  const filteredUser = userAgents.filter((a) => !overriddenNames.has(a.name))

  return [...filteredUser, ...repoAgents]
}
