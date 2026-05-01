/** @jsxImportSource @opentui/solid */

export const ERROR_STATE_TITLE =
  'The Copilot delegate TUI plugin is not responding.'
export const ERROR_STATE_HINT =
  'Try reloading the plugin (or run /copilot-status again).'

type ErrorStateProps = {
  message: string
}

export function ErrorState(props: ErrorStateProps) {
  return (
    <box flexDirection="column" flexGrow={1} justifyContent="center">
      <text>{ERROR_STATE_TITLE}</text>
      <text>{props.message}</text>
      <text>{ERROR_STATE_HINT}</text>
    </box>
  )
}

export default ErrorState
