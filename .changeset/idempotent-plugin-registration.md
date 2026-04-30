---
'opencode-copilot-delegate': minor
---

Make the plugin factory idempotent across multiple OpenCode config sources within the same process. When `~/.config/opencode/opencode.json` AND a project-level `opencode.json` (or any other combination of config sources) both list `opencode-copilot-delegate`, OpenCode previously invoked the factory once per source — each invocation evaluating the plugin module fresh, running orphan reaping, and registering its own copy of the three tools. The result was duplicated tools in the catalog, duplicated init side effects (PID-file `mkdir`, `reapOrphans`), and per-invocation closure state that could diverge across registrations.

The factory now resolves at most once per process via a `globalThis` symbol singleton (`Symbol.for('opencode-copilot-delegate.singleton.v1')`). Subsequent invocations within the same PID return the cached hooks promise, skip the heavy init, and emit a single one-shot warning (via `console.warn` AND `client.app.log` under `service=copilot-delegate`) so duplicate-config situations remain observable in logs. Across distinct OpenCode processes the singleton is fresh — each process initializes normally.

No configuration change is required for users with a single config source. Users with duplicate registrations will see one warning per process and a single set of tools in the catalog.
