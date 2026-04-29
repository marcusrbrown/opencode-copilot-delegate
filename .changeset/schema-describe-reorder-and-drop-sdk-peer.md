---
'opencode-copilot-delegate': minor
---

Surface per-parameter descriptions to host LLMs and drop the unused `@opencode-ai/sdk` peer dependency.

OpenCode's tool-list endpoint serializes plugin schemas with Zod's `toJSONSchema(..., { io: 'input' })` mode, which unwraps `.optional()` wrappers and drops any `.describe()` text attached to the wrapper. The 5 optional parameters across `copilot_delegate` and `copilot_output` chained `.optional().describe(...)` and lost their descriptions in the rendered tool catalog. Reordering to `.describe(...).optional()` places the description on the leaf type so it survives the unwrap.

Also drops `@opencode-ai/sdk` from `peerDependencies` and the build externals — the package was never imported from any source file, so the peer requirement was dead config that forced consumers to install an unused dependency.
