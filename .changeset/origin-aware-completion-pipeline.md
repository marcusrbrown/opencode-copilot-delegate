---
'opencode-copilot-delegate': minor
---

Extract the post-completion pipeline (`SpawnCopilotResult` → `TaskState` back-patch + completion notification) into a shared `attachCompletionPipeline` helper in `src/runtime/notify.ts`. `copilot_delegate` now delegates its `void task.completionPromise.then(...)` block to this helper; the upcoming `copilot_resume` tool will reuse it without duplicating the load-bearing field sync.

Notification headers are now origin-aware: tasks created with `origin: 'spawn'` (today's only call site) keep the existing `[COPILOT DELEGATION COMPLETED]` header. Tasks with `origin: 'resume'` will surface `[COPILOT RESUME COMPLETED]` so users can distinguish a resumed Copilot session from a fresh delegation. The `connect` header is wired for forward compatibility but no `connect`-origin tasks are constructed in this slice.
