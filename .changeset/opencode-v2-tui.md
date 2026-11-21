---
'opencode-copilot-delegate': minor
---

add `/copilot-status` on OpenCode 2.x: the `./tui` entry now exports `{ id, tui, setup }`, so V1 keeps using `tui` and V2 uses `setup` with host dialogs and a global palette/slash command. The V2 TUI runs in a separate process from the server, so the server now keys its RPC port file by its own pid and the TUI reads that pid from the server it is connected to. `@opentui/core`, `@opentui/solid` and `solid-js` move from `dependencies` to dev dependencies and optional peers: both hosts supply their own copies at runtime
