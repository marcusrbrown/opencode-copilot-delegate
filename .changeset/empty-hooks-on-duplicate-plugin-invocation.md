---
'opencode-copilot-delegate': minor
---

Fix host-side double registration of `copilot_delegate`, `copilot_output`, and `copilot_cancel` when the plugin is listed in both a user-level and project-level `opencode.json`.

Previously, the per-process register-once guard returned the cached real hooks to every duplicate factory invocation in the same PID. The OpenCode host iterates each plugin source's returned hook surface and registers every tool entry it finds, even when two sources return the same JS reference. That meant each tool appeared twice in the LLM-visible tool catalog under dual-source configurations.

The guard now returns empty hooks (`{}`) on duplicate invocations so the host has nothing to register a second time. The first invocation still runs `doInit` once and receives the real hooks; subsequent invocations in the same PID receive `{}` and emit a one-time warning. Heavy initialization (agent discovery, orphan reaping, RPC server startup) still runs at most once per process.

Single-source configurations are unaffected.
