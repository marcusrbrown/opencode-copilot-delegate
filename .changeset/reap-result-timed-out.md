---
'opencode-copilot-delegate': minor
---

Add `timed_out: boolean` to `ReapResult` so consumers can distinguish a successful no-op reap (nothing to do) from a timeout-aborted reap (gave up; orphans may remain). The flag is `false` on every success path and `true` only when the overall `reapOrphans` timeout fires.
