# opencode-copilot-delegate

An [OpenCode](https://opencode.ai) plugin that delegates tasks to [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli) as background subprocesses.

## Overview

This plugin registers four tools in OpenCode:

- **`copilot_delegate`**: Spawn `copilot -p` as a background subprocess. Returns a `task_id` immediately so the parent agent never blocks.
- **`copilot_output`**: Retrieve the structured result envelope for a completed or running delegation.
- **`copilot_cancel`**: Cancel a running delegation with SIGTERM → SIGKILL escalation.
- **`copilot_resume`**: Continue a previous Copilot session.

When a delegation finishes, a `<system-reminder>` notice is injected into the parent session. A completion while other delegations from that session are still running is recorded silently. The last completion starts a turn, and so does any failure or cancellation.

- On OpenCode 1.x this uses `client.session.prompt` with `noReply`.
- On OpenCode 2.x it uses `session.synthetic`: `resume: false` for silent notices, `delivery: 'queue'` for the last completion (it waits for the active turn), and `delivery: 'steer'` for failures.

## Installation

The same package works on OpenCode 1.x (`>=1.14.41`) and 2.x (`>=2.3.2`). Each host's plugin package is an optional peer dependency.

```json
// opencode.json
{
  "plugin": ["opencode-copilot-delegate"]
}
```

On OpenCode 2.x the host reactivates plugins on config changes, plugin edits, and edits to plugins listed before this one. When the last activation in the process ends, running delegations are cancelled and the in-memory task list is cleared, so earlier `task_id`s then return `unknown`.

### The `/copilot-status` TUI half

The server plugin works by itself. `/copilot-status` is an optional terminal UI.

**OpenCode 1.x:** install the TUI half in OpenCode's TUI config:

```jsonc
// tui.jsonc
{
  "plugin": ["opencode-copilot-delegate/tui"]
}
```

**OpenCode 2.x:** nothing extra to install. The TUI loads the `./tui` entry of any plugin the server lists with a TUI half, so the `opencode.json` entry above is enough. `/copilot-status` and a "Copilot Status" palette command appear once the plugin is active.

On both hosts `/copilot-status` lists running delegations and lets you cancel one. The OpenCode 2.x TUI runs in a different process from the server, so it finds the server's port file by the server's pid (read from the server it is connected to). If the TUI is connected to a remote server (`--server <url>`), the port file is on the other machine. `/copilot-status` notices that the server's hostname differs from this machine's and reports that status is only available for a local server.

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

| Arg          | Type        | Description                                                               |
| ------------ | ----------- | ------------------------------------------------------------------------- |
| `prompt`     | `string`    | Required. The prompt to send to Copilot. Must be non-empty.               |
| `agent`      | `string?`   | Optional. Copilot agent name (see tool description for available agents). |
| `model`      | `string?`   | Optional. Model override (e.g. `claude-haiku-4.5`).                       |
| `add_dir`    | `string[]?` | Optional. Additional directories to allow Copilot to read.                |
| `allow_tool` | `string[]?` | Optional. Tool patterns to allow.                                         |
| `deny_tool`  | `string[]?` | Optional. Tool patterns to deny.                                          |

Returns `{ task_id: string }` — a `cpl_`-prefixed UUID.

### `copilot_output`

| Arg          | Type       | Description                                                                    |
| ------------ | ---------- | ------------------------------------------------------------------------------ |
| `task_id`    | `string`   | Required. Task ID from `copilot_delegate`.                                     |
| `block`      | `boolean?` | Optional. Wait for completion before returning. Default `false`.               |
| `timeout_ms` | `integer?` | Optional. Max wait ms when `block: true`. Default `30000`, range `0`–`120000`. |

Returns a structured envelope with `status`, `final_message`, `tokens`, `tool_calls_summary`, and more.

### `copilot_cancel`

| Arg       | Type     | Description                  |
| --------- | -------- | ---------------------------- |
| `task_id` | `string` | Required. Task ID to cancel. |

Returns `{ cancelled: boolean; was_running: boolean }`.

### `copilot_resume`

Resume a prior Copilot session by UUID, name, or unique name prefix. Wraps `copilot --resume=<target_id>` and runs the resumed session as a background subprocess, like `copilot_delegate`. It sends no new prompt. Retrieve the result with `copilot_output` and cancel with `copilot_cancel`, using the returned `task_id`.

| Arg          | Type        | Description                                                                                                                                                                                                                |
| ------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_id`  | `string`    | Required. Non-empty. Copilot session UUID, session name, or unique name prefix. A UUID is checked against the local Copilot session store before spawning. A plugin `cpl_*` task ID is not accepted; use `copilot_output`. |
| `cwd`        | `string?`   | Optional. Working directory for the resumed session. Must be an absolute path within the active workspace. Defaults to the plugin directory.                                                                               |
| `add_dir`    | `string[]?` | Optional. Additional directories to allow Copilot to read. When omitted and a prior task in this process matches `target_id`, that task's `add_dir` values are reused.                                                     |
| `config_dir` | `string?`   | Optional. Copilot config directory used for the UUID session lookup and passed to the subprocess as `COPILOT_CONFIG_DIR`. Defaults to `~/.copilot` (or the `COPILOT_CONFIG_DIR` env var). Rarely needed.                   |

Returns `{ task_id: string }` on success, or `{ error: string }` (for example when no session matches `target_id`, or an input fails validation). The same concurrency cap as `copilot_delegate` applies: at most 10 running Copilot tasks.

## Scope Boundary

Task state is in-memory inside a single OpenCode process, and it is shared by every workspace that process serves. When one OpenCode server opens several project directories, each directory gets its own `copilot_*` tools, which run Copilot in that directory and discover that repo's `.github/agents`. There is one task list for the whole process, and one RPC server, which feeds `/copilot-status`. If the same directory loads the plugin from more than one config source, only the first registers tools. Calling `copilot_output` from a different OpenCode process returns `{ status: 'unknown', error: 'task_id not found in this OpenCode process' }`. Cross-process sharing is deferred to a future version.

## Known Limitations

- **Orphaned subprocesses (mitigated since v0.2.0):** If OpenCode crashes mid-delegation, the `copilot` subprocess becomes orphaned. A PID-file reaper now scans `<XDG_STATE_HOME>/opencode-copilot-delegate/orphans/` at every plugin init, probes the owning plugin's liveness, and reaps subprocesses whose plugin has exited. A strict identity gate (kernel-tracked `comm` + start time) prevents PID-reuse misfires.
- **Prompt visibility in `ps`:** The `copilot` CLI accepts the prompt as a command-line argument, which means the full prompt text appears in `ps` output for any user on the host. This is an upstream Copilot CLI behavior. Avoid delegating prompts that contain secrets or PII; pass sensitive material via files, env vars, or `--secret-env-vars` instead.
- **No subprocess lifetime cap:** A hung `copilot` subprocess stays in the registry as `running` indefinitely. Cancel manually via `copilot_cancel`. A configurable timeout is planned for v1.x.
- **TUI half is opt-in:** The package ships server and TUI entrypoints. Existing server-only installs continue to register the four tools; `/copilot-status` only appears when the TUI entrypoint is installed.
- **RPC server cleanup is best-effort:** The server half exposes a localhost-only RPC listener for the TUI and writes an authenticated port file under `<XDG_CACHE_HOME or ~/.cache>/opencode/copilot-delegate/<id>/`, where `<id>` is the OpenCode session id on 1.x and the server's pid on 2.x. On OpenCode 1.x the server plugin API has no dispose hook, so cleanup is tied to process exit signals and the orphan reaper covers missed shutdowns. On OpenCode 2.x the last plugin activation's cleanup closes the server and removes its port file.

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
