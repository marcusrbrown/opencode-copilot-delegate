---
'opencode-copilot-delegate': minor
---

Isolate the integration-test OpenCode subprocess from the developer's globally configured plugins.

The integration tests now redirect `HOME`, `XDG_*`, `OPENCODE_TEST_HOME`, and `OPENCODE_TEST_MANAGED_CONFIG_DIR` to a per-fixture temp directory before spawning `opencode serve`. This prevents user-level plugins (e.g., installed under `~/.config/opencode/opencode.json`) from being loaded into throwaway test sessions and from writing storage under the developer's `~/.local/share/opencode/`. Mirrors the env-var pattern OpenCode uses in its own test preload.

Internal changes:

- `tests/integration/helpers/server.ts` exposes `homeDir`/`managedConfigDir` options on `startServer` and pre-resolves the native opencode binary so the spawn bypasses the JS wrapper's mise-shimmed `node` lookup, which would otherwise fail under a redirected `XDG_DATA_HOME`.
- `tests/integration/opencode.test.ts` `makeProjectDir` now returns a fixture object (`{ rootDir, projectDir, homeDir, managedConfigDir }`), pre-stages `@opencode-ai/plugin` into the fixture's `.opencode/node_modules/`, and bumps the first project-bootstrap test's timeout to absorb cold-start cost.
