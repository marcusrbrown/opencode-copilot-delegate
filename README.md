# opencode-copilot-delegate

An [OpenCode](https://opencode.ai) plugin that delegates tasks to [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) as background subprocesses.

## Overview

This plugin registers three tools in OpenCode:

- **`copilot_delegate`** — Spawn `copilot -p` as a background subprocess. Returns a `task_id` immediately so the parent agent never blocks.
- **`copilot_output`** — Retrieve the structured result envelope for a completed or running delegation.
- **`copilot_cancel`** — Cancel a running delegation with SIGTERM → SIGKILL escalation.

When the subprocess completes, a `<system-reminder>` notification is injected into the parent session via `client.session.promptAsync`, mirroring the async pattern used by OMO.

## Installation

```json
// opencode.json
{
  "plugin": ["opencode-copilot-delegate"]
}
```

Requires the `copilot` CLI to be on `PATH`. Install via:

```sh
# npm (recommended)
npm install -g @github/copilot

# Homebrew
brew install copilot-cli

# Install script (CI-friendly)
curl -fsSL https://gh.io/copilot-install | bash
```

## Authentication

The plugin passes through your existing Copilot CLI auth. Token precedence:

```
COPILOT_GITHUB_TOKEN > GH_TOKEN > GITHUB_TOKEN > ~/.copilot/auth
```

The plugin logs the resolved auth source (not the token value) at delegation start.

## Tools

### `copilot_delegate`

| Arg | Type | Description |
|-----|------|-------------|
| `prompt` | `string` | Required. The prompt to send to Copilot. |
| `agent` | `string?` | Optional. Copilot agent name (see tool description for available agents). |
| `model` | `string?` | Optional. Model override (e.g. `claude-haiku-4.5`). |
| `add_dir` | `string[]?` | Optional. Additional directories to allow Copilot to read. |
| `allow_tool` | `string[]?` | Optional. Tool patterns to allow. |
| `deny_tool` | `string[]?` | Optional. Tool patterns to deny. |

Returns `{ task_id: string }` — a `cpl_`-prefixed UUID.

### `copilot_output`

| Arg | Type | Description |
|-----|------|-------------|
| `task_id` | `string` | Required. Task ID from `copilot_delegate`. |
| `block` | `boolean?` | Optional. Wait for completion before returning. Default `false`. |
| `timeout_ms` | `number?` | Optional. Max wait ms when `block: true`. Default `30000`, max `120000`. |

Returns a structured envelope with `status`, `final_message`, `tokens`, `tool_calls_summary`, and more.

### `copilot_cancel`

| Arg | Type | Description |
|-----|------|-------------|
| `task_id` | `string` | Required. Task ID to cancel. |

Returns `{ cancelled: boolean; was_running: boolean }`.

## Scope Boundary

Task state is in-memory inside a single OpenCode process. Calling `copilot_output` from a different OpenCode process returns `{ status: 'unknown', error: 'task_id not found in this OpenCode process' }`. Cross-process sharing is deferred to a future version.

## Known Limitations (v0.1.x)

- **Orphaned subprocesses:** If OpenCode crashes mid-delegation, the `copilot` subprocess becomes orphaned. A PID-file reaper is planned for v1.x.

## Privacy

This plugin collects **zero telemetry**. It does not phone home, track usage, or log to remote services. All logging goes through `client.app.log(...)`, which OpenCode handles locally per its own settings. The resolved auth token value is never logged — only the auth source name.

## License

MIT © [Marcus R. Brown](https://mrbro.dev)
