---
'opencode-copilot-delegate': minor
---

Surface per-parameter `.describe()` text to the host runtime by patching each tool arg schema with a `_zod.toJSONSchema` override.

OpenCode's tool catalog renders plugin schemas via the host's bundled zod, which lives in a different module instance from the plugin's zod and cannot see the plugin-side `.describe()` metadata registry. The override delegates serialization back to the plugin-local zod so descriptions survive intact, mirroring the pattern shipped by `@cortexkit/opencode-magic-context` and `@cortexkit/aft-opencode`.

Also pins `zod` as a direct dependency (`^4.3.0`) with a matching `overrides` entry to keep this repo's dependency tree on a single zod version, resolving a TS2883 unportable-inferred-type error from two zod trees coexisting at build time. The `overrides` field is local to this repo's installs only; npm ignores it for downstream consumers, so external plugin authors importing this package may still see a different transitive zod from their OpenCode host. Also reverts the prior schema-chain reorder since the override makes ordering irrelevant.
