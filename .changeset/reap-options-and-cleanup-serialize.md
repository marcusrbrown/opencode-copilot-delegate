---
'opencode-copilot-delegate': patch
---

Tighten orphan-reaper internals: export `ReapOptions` (consolidates `ReapDeps` + reap-specific opts via interface extension), consolidate `reapOneFile` to a single opts-bag parameter, and route `cleanupAfterReap` writes through the per-file `serializeWrite` lock via two new helpers (`truncatePidFile`, `unlinkPidFile`) so any future change that runs reap concurrent with task spawns is automatically race-safe. No user-visible behavior change in default usage.
