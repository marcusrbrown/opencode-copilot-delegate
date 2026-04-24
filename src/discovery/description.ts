import type { Agent } from './agents'

const MAX_DISPLAYED = 20

export function buildDescription(agents: Agent[]): string {
  const displayed = agents.slice(0, MAX_DISPLAYED)
  const remaining = agents.length - MAX_DISPLAYED

  const lines = ['Available Copilot agents:']

  for (const agent of displayed) {
    lines.push(`  - ${agent.name} (${agent.source})`)
  }

  if (remaining > 0) {
    lines.push(
      `  ... and ${remaining} more (use copilot_list_agents to see all)`,
    )
  }

  return lines.join('\n')
}
