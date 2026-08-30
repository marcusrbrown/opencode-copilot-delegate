---
'opencode-copilot-delegate': patch
---

Update @opentui/core and @opentui/solid to v0.4.3. Pins both packages to the same version via an `overrides` entry so TypeScript resolves the branded renderable types from a single installation. Fixes type errors caused by `@opentui/solid@0.4.3` bundling its own `@opentui/core`, which created duplicate `TextRenderable`/`BoxRenderable`/`KeyEvent` type identities that broke `bun run typecheck`.