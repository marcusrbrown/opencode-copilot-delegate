# opencode-copilot-delegate

An [OpenCode](https://opencode.ai) plugin that delegates tasks to [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) as background subprocesses.

## Overview

This plugin registers three tools in OpenCode:

- **`copilot_delegate`** — Spawn `copilot -p` as a background subprocess. Returns a `task_id` immediately so the parent agent never blocks.
- **`copilot_output`** — Retrieve the structured result envelope for a completed or running delegation.
- **`copilot_cancel`** — Cancel a running delegation with SIGTERM → SIGKILL escalation.

When the subprocess completes, a `<system-reminder>` notification is injected into the parent session via `client.session.prompt` with `noReply: false` for the first notification per session and `noReply: true` for subsequent ones, so the agent sees the result without an unbounded reply chain.

## Installation

```json
// opencode.json
{
  "plugin": ["opencode-copilot-delegate"]
}
```

### Optional: install the TUI half

The server plugin works by itself. To enable the `/copilot-status` terminal UI, also install the TUI half in OpenCode's TUI config:

```jsonc
// tui.jsonc
{
  "plugin": ["opencode-copilot-delegate/tui"]
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

## Known Limitations

- **Orphaned subprocesses (mitigated since v0.2.0):** If OpenCode crashes mid-delegation, the `copilot` subprocess becomes orphaned. A PID-file reaper now scans `<XDG_STATE_HOME>/opencode-copilot-delegate/orphans/` at every plugin init, probes the owning plugin's liveness, and reaps subprocesses whose plugin has exited. A strict identity gate (kernel-tracked `comm` + start time) prevents PID-reuse misfires.
- **Prompt visibility in `ps`:** The `copilot` CLI accepts the prompt as a command-line argument, which means the full prompt text appears in `ps` output for any user on the host. This is an upstream Copilot CLI behavior. Avoid delegating prompts that contain secrets or PII; pass sensitive material via files, env vars, or `--secret-env-vars` instead.
- **No subprocess lifetime cap:** A hung `copilot` subprocess stays in the registry as `running` indefinitely. Cancel manually via `copilot_cancel`. A configurable timeout is planned for v1.x.
- **TUI half is opt-in:** The package ships server and TUI entrypoints. Existing server-only installs continue to register the three tools; `/copilot-status` only appears when the TUI entrypoint is installed.
- **RPC server cleanup is best-effort:** The server half exposes a localhost-only RPC listener for the TUI and writes a per-session authenticated port file under `<XDG_CACHE_HOME or ~/.cache>/opencode/copilot-delegate/`. OpenCode's server plugin API has no dispose hook today, so cleanup is tied to process exit signals and the orphan-reaper posture covers missed shutdowns.

## Versioning

Releases under `0.x` are unstable and may include breaking changes between minor versions. Pin to an exact version in production:

```json
"dependencies": {
  "opencode-copilot-delegate": "0.1.0"
}
```

`1.0.0` will be cut once the public surface stabilizes.

## Privacy

This plugin collects **zero telemetry**. It does not phone home, track usage, or log to remote services. All logging goes through `client.app.log(...)`, which OpenCode handles locally per its own settings. The resolved auth token value is never logged — only the auth source name.

## License

MIT © [Marcus R. Brown](https://mrbro.dev)
