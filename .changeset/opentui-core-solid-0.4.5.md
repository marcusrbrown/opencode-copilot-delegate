---
'opencode-copilot-delegate': patch
---

Update `@opentui/core` and `@opentui/solid` to v0.4.5 (from v0.2.7 on `main`). Supersedes the stale Renovate PR #135 (which targeted v0.4.3); upstream has since published v0.4.5. Pins `@opentui/core` to the same version via a new `overrides` entry so TypeScript resolves branded renderable types (`TextRenderable`, `BoxRenderable`, `KeyEvent`, …) from a single installation, preventing the duplicate-type-identity regressions that `@opentui/solid@0.4.x` would otherwise introduce by bundling its own `@opentui/core`.