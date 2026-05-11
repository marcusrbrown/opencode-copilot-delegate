---
'opencode-copilot-delegate': minor
---

Add `copilot_resume` tool for resuming prior Copilot sessions by ID, name, or prefix.

The new tool wraps `copilot --resume=<target>` and integrates fully with the existing task lifecycle — output, cancel, and completion notifications all work the same way as delegated tasks.

Key behaviors:
- UUID targets are validated against the local Copilot session store before spawning; missing sessions return a structured error without touching the CLI.
- When a prior plugin task's session ID matches the target, its workspace paths (`--add-dir` set) are reused automatically when the caller omits `addDirs`.
- CLI no-match errors (`Error: No session, task, or name matched '...'`) are normalized to a clean `Session not found` response.
- All path inputs (`cwd`, `addDirs`) are validated against allowed roots before spawn; argv-injection-shaped values are rejected.

The tool catalog grows from 3 to 4. Resume + new prompt (fork) is not part of this release.
