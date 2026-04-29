---
'opencode-copilot-delegate': minor
---

Surface per-parameter `.describe()` text to the host runtime by patching each tool arg schema with a `_zod.toJSONSchema` override.

OpenCode's tool catalog renders plugin schemas via the host's bundled zod, which lives in a different module instance from the plugin's zod and cannot see the plugin-side `.describe()` metadata registry. The override delegates serialization back to the plugin-local zod so descriptions survive intact, mirroring the pattern shipped by `@cortexkit/opencode-magic-context` and `@cortexkit/aft-opencode`.

Also pins `zod` as a direct dependency (`^4.3.0`) so the resolved version no longer drifts based on transitive resolution, and reverts the prior schema-chain reorder since the override makes ordering irrelevant.
