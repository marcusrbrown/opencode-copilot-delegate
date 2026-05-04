---
'opencode-copilot-delegate': patch
---

Stabilize the cancel-process-tree test against CI runner load by polling `process.kill(pid, 0)` with a 2s deadline instead of asserting synchronously. Test-only change; no plugin behavior or consumer surface affected.
