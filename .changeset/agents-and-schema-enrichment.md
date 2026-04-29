---
'opencode-copilot-delegate': minor
---

Drop `BUILTIN_AGENTS` and enrich tool schema descriptions

**`BUILTIN_AGENTS` removal.** The plugin previously advertised six "built-in" agent names — `default`, `explore`, `task`, `general-purpose`, `code-review`, `research` — inherited from VS Code Copilot Chat / OpenCode conventions. The standalone `@github/copilot` CLI v1.0.36 ships zero of these; passing any of them as `--agent <name>` causes Copilot CLI to fail at spawn time with `Error: No such agent: <name>, available:`. The constant has been removed. `discoverAgents` now returns user agents (filtered by repo override) followed by repo agents; `Agent.source` is `'user' | 'repo'`. `buildDescription` handles the empty-discovery case by emitting an actionable hint pointing at `~/.copilot/agents` and `.github/agents`.

**Tool schema enrichment.** The three exposed tools — `copilot_delegate`, `copilot_output`, `copilot_cancel` — now ship multi-paragraph tool descriptions covering what they do, when to use them, lifecycle, common pitfalls, and return-value shape. Per-parameter `.describe()` text spells out type, default, when-required, example values, and constraints. Examples follow the patterns Magic Context's `ctx_*` tools established. The new descriptions surface in OpenCode's tool registry exposure to LLMs and via `mise run opencode:doctor --only tools`.

No runtime behavior change beyond the agent discovery fix. Tool argument shapes are unchanged; existing callers continue to work without modification.
