---
'opencode-copilot-delegate': minor
---

Rebuild `/copilot-status` on the host's `DialogSelect`, `DialogConfirm`, and `DialogAlert` components. The modal is now themed like the rest of OpenCode and responds to the keyboard: ↑/↓ move the highlight, Enter on a running task opens the cancel confirm, and Esc closes cleanly. `/copilot-status` is also registered as a real slash command (`slashName`), so it appears when you type `/`.
