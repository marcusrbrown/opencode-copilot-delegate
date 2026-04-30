---
'opencode-copilot-delegate': minor
---

Harden PID file and orphan-reaper state path handling against same-user symlink attacks.

- Use no-follow PID file opens for read and truncate paths so symlinked `.pids` files are rejected instead of read or truncated.
- Reject symlinked PID file parent directories before orphan reaping, cleanup, and plugin init state-directory creation so `orphans/` scans and cleanup do not follow attacker-controlled links.
