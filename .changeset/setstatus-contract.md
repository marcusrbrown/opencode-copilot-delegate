---
'opencode-copilot-delegate': patch
---

Tighten the `setStatus` lifecycle helper to forbid terminal → non-terminal transitions. Once a task reaches `complete`, `failed`, or `cancelled`, every subsequent `setStatus` call is a no-op. Previously the helper short-circuited only when both old and new status were terminal, leaving an unintended resurrection path that no caller exercises but the contract permitted. Pure contract tightening; no caller behavior changes.
