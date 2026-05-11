---
'opencode-copilot-delegate': minor
---

Make the TUI plugin survive OpenCode's `api.command.register` migration.

OpenCode 1.14.42 removed `api.command.register` in favor of the new keymap engine. 1.14.44+ restored `api.command.register` as a deprecated shim that translates to `api.keymap.registerLayer` internally. The TUI plugin's `/copilot-status` command was unconditionally calling `api.command.register`, which would silently disappear on OpenCode versions where the call path went away.

The TUI entry now runtime-feature-detects:

- **OpenCode 1.14.44+** (canonical): registers via `api.keymap.registerLayer({ commands: [{ namespace: 'palette', name: 'copilot-status', title: 'Copilot Status', category: 'Copilot', run() }], bindings: [] })`. Mirrors the dual-path pattern Magic Context established in commit `5fe1c4f`.
- **OpenCode 1.14.41** (the prior pinned version): falls back to `api.command.register(...)` with the original command shape, so the slash menu continues to surface `/copilot-status` exactly as before.
- **Neither API present** (defensive): logs a warning and continues to load the plugin without the slash command. The status modal remains available via direct API consumers.

Other surfaces:

- `devDependencies['@opencode-ai/plugin']` moves from `1.14.41` to `1.14.48` so tests run against the canonical keymap API.
- `peerDependencies['@opencode-ai/plugin']` narrows from `>=1.14.0` to `>=1.14.41` to align advertised compatibility with what's actually tested.
