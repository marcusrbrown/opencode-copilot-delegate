import type { Agent } from './agents'

const MAX_DISPLAYED = 20

/**
 * Render a human-readable list of discovered agents for inclusion in the
 * `copilot_delegate` tool description. Lists user and repo agents (no
 * builtins; Copilot CLI v1.0.36 ships none). Truncates at MAX_DISPLAYED
 * entries with a count of the rest.
 */
export function buildDescription(agents: Agent[]): string {
  if (agents.length === 0) {
    return [
      'No Copilot agents discovered.',
      'Add `.agent.md` files to `~/.copilot/agents` (user-level) or',
      '`.github/agents` (repo-level) to make them available here.',
    ].join('\n')
  }

  const displayed = agents.slice(0, MAX_DISPLAYED)
  const remaining = agents.length - MAX_DISPLAYED

  const lines = ['Available Copilot agents:']

  for (const agent of displayed) {
    lines.push(`  - ${agent.name} (${agent.source})`)
  }

  if (remaining > 0) {
    lines.push(
      `  ... and ${remaining} more (see ~/.copilot/agents or .github/agents)`,
    )
  }

  return lines.join('\n')
}
