---
'opencode-copilot-delegate': minor
---

Add an orphan subprocess reaper that runs at plugin init to clean up `copilot` subprocesses left behind when the plugin reloads or the OpenCode session exits unexpectedly.

The reaper writes a per-instance PID file at `<XDG_STATE_HOME>/opencode-copilot-delegate/orphans/<plugin-pid>.pids` for every subprocess the plugin spawns and removes the entry on every terminal status transition (complete, failed, cancelled). On the next plugin init, the reaper scans the orphans directory, probes the owning plugin's liveness for each foreign file (`process.kill(<plugin-pid>, 0)`), reaps entries from files whose plugin has exited (and deletes those files), and skips entries from files whose plugin is still running.

Identity gate is strict: each kill requires the live process's `comm` (kernel-tracked executable name from `ps -o comm=`) AND `lstart` (start-time string) to match values recorded at spawn time. Combined with the spawner-liveness probe, this prevents both PID-reuse-of-an-unrelated-process and cross-instance kill of a live foreign instance's children.

Also fixes a parser cancel-race in the JSONL data handler — events buffered before the abort listener fired could previously be appended to `task.events` after `task.status` had been set to `cancelled`. The fix is a one-line `if (task.status !== 'running') break` guard at the top of the per-line loop, before `parseJsonlLine`.

The new `setStatus` helper centralizes the three terminal status mutations in `subprocess.ts` (close event, abort listener, spawn error) along with the `removePidEntry` cleanup hook. It is idempotent on terminal state — once `task.status` is terminal, subsequent `setStatus` calls with another terminal value no-op, preserving the existing `finalizeTask` `if (task.status !== 'cancelled')` invariant automatically.
