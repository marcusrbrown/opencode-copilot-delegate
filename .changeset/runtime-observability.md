---
'opencode-copilot-delegate': minor
---

Improve runtime observability and fix a silent failure in completion notifications.

- `killProcessTree` now classifies fkill failures by probing the process group with `process.kill(-pid, 0)`. ESRCH is reported as an already-gone group and the failure is suppressed; alive or unknown states preserve the original throw with a more accurate warning. The probe targets `-pid` (the process group) rather than the leader so children leaking after a leader exit are no longer misclassified as benign.
- `notifyCompletion`'s fallback `client.app.log` call now uses the structured SDK shape (`{ body: { service, level, message } }`) and is wrapped in `try/catch` so synchronous SDK throws can no longer escape the documented "never throws" contract.
- All runtime warnings now share the `[copilot-delegate]` prefix across `kill-tree`, `orphan-reaper`, `pid-file`, `task-registry`, and `task-status`, making operator log filtering predictable.
- Internal contract documentation: `setStatus` and `writeChains` carry JSDoc covering terminal-state transitions and the per-file serialize chain.
