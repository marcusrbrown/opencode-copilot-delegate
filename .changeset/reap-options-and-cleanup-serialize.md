---
'opencode-copilot-delegate': minor
---

Tighten orphan-reaper internals and add two new exported helpers from `src/runtime/pid-file.ts`:

- `truncatePidFile(filePath)` — truncate under the per-file `serializeWrite` lock; ENOENT (file or parent missing) silently swallowed.
- `unlinkPidFile(filePath)` — unlink under the per-file `serializeWrite` lock; ENOENT silently swallowed.

Also export `ReapOptions` from `src/runtime/orphan-reaper.ts` (consolidates `ReapDeps` + reap-specific opts via interface extension), and consolidate `reapOneFile` to a single opts-bag parameter. `cleanupAfterReap` now routes its truncate-on-current and unlink-on-foreign paths through the new helpers so any future change that runs reap concurrent with task spawns is automatically race-safe.

No user-visible behavior change in default usage; the bump reflects the new exported surface.
