---
'opencode-copilot-delegate': minor
---

Add integration test scaffolding that spawns a real OpenCode server subprocess on an ephemeral port, verifies the plugin's three tools (`copilot_delegate`, `copilot_output`, `copilot_cancel`) appear in the tool catalog, and confirms clean teardown without zombie processes. Adds a `test:integration` script that runs only `tests/integration/`.
