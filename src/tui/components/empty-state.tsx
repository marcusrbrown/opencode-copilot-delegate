/** @jsxImportSource @opentui/solid */

export const EMPTY_STATE_TITLE = 'No Copilot delegations are running.'
export const EMPTY_STATE_HINT =
  'Start one with the copilot_delegate tool, then reopen /copilot-status.'

export function EmptyState() {
  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center">
      <text>{EMPTY_STATE_TITLE}</text>
      <text>{EMPTY_STATE_HINT}</text>
    </box>
  )
}

export default EmptyState
