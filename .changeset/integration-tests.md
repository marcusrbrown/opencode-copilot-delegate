---
'opencode-copilot-delegate': minor
---

Add LLM-driven integration tests that exercise the full session-prompt path end-to-end: a real OpenCode session with the `opencode/big-pickle` model invokes `copilot_delegate`, `copilot_output`, and `copilot_cancel` against real Copilot subprocesses, with assertions on tool-state outputs. Five scenarios cover task-id format, blocking-output timeout, cancel-running, unknown-task-id, and `<system-reminder>` injection.

The describe block is gated on either `GH_TOKEN` or `COPILOT_PAT` being set (CI uses the secret-backed `GH_TOKEN`; local dev `.env` typically uses `COPILOT_PAT`). When neither is present, the suite skips cleanly so `bun test` stays green on dev machines without a Copilot PAT.
