---
title: Copilot CLI Capabilities — Programmatic Delegation Reference
date: 2026-04-27
copilot_version: 1.0.36
delegated_to: copilot_delegate (model=claude-opus-4.7)
task_id: cpl_2c867887-eed5-4048-98d2-69a4a8f2a731
runtime_minutes: 5
premium_requests: 7.5
purpose: Seed ideation for opencode-copilot-delegate v0.2.x feature work.
errata:
  - "§9 'Prompts visible in ps': the suggested temp-file wrapper does not address argv leakage. Copilot CLI 1.0.36 has no documented stdin or @file prompt mode; treat that bullet as 'no known workaround in 1.0.36' until upstream exposes one."
---

# Copilot CLI Capabilities — Programmatic Delegation Reference

**Subject:** `@github/copilot` standalone CLI (NOT `gh copilot`)
**Pinned version:** `GitHub Copilot CLI 1.0.36` (`copilot --version`)
**Sources:** `copilot help`, `copilot help <topic>` (commands, config, environment, logging, monitoring, permissions, providers), public docs at `docs.github.com/en/copilot/reference/copilot-cli-reference/*`, inspection of `~/.copilot/`. Where help and docs disagree, **help output wins** and the divergence is called out.

---

## 1. Programmatic flags reference

Grouped table of `-p`-relevant flags. Source key: **H** = `copilot help`, **HP** = `copilot help permissions`, **HE** = `copilot help environment`, **HC** = `copilot help config`, **D** = public docs.

| Category | Flag | Notes / Source |
|---|---|---|
| Invocation | `-p, --prompt <text>` | Non-interactive run; exits on completion. **H** |
| Invocation | `-i, --interactive <prompt>` | Interactive but seeded with prompt. **H** |
| Invocation | `--continue` / `--resume[=id\|name\|prefix]` | Resume by id, task id, name (case-insensitive exact), or 7+ hex prefix. **H** |
| Invocation | `--connect[=sessionId]` | Connect to a remote session/task. **H** |
| Invocation | `-n, --name <name>` | Name new session; recoverable via `--resume=<name>`. **H** |
| Invocation | `--mode <interactive\|plan\|autopilot>`, `--plan`, `--autopilot`, `--max-autopilot-continues <n>` | Initial mode. **H** |
| Invocation | `--acp` | Run as Agent Client Protocol server (stdin/stdout). **H** |
| Permissions | `--allow-all` / `--yolo` | Equivalent: `--allow-all-tools --allow-all-paths --allow-all-urls`. **HP** |
| Permissions | `--allow-all-tools` (env `COPILOT_ALLOW_ALL=true`) | Required for `-p` non-interactive. **H/HP** |
| Permissions | `--allow-tool[=tools...]` / `--deny-tool[=tools...]` | Pattern: `kind(arg)`; deny wins. Kinds: `shell`, `write`, `read`*, `url`, `memory`*, `<mcp-server>`. *`read`/`memory` only documented in **D**, not in `help permissions`. |
| Permissions | `--available-tools[=tools...]` / `--excluded-tools[=tools...]` | Hard model-visibility filter (independent of allow/deny). **HP** |
| Permissions | `--allow-all-paths` / `--add-dir <dir>` (repeatable) / `--disallow-temp-dir` | Path sandbox. CWD + temp default; `--add-dir` extends. **HP** |
| Permissions | `--allow-all-urls` / `--allow-url[=urls...]` / `--deny-url[=urls...]` | Protocol-aware; deny wins. **HP** |
| Permissions | `--no-ask-user` | Disable `ask_user` tool — required for fully unattended runs. **H** |
| Permissions | `--secret-env-vars[=vars...]` | Strip vars from shell/MCP env and redact in output. `GITHUB_TOKEN` and `COPILOT_GITHUB_TOKEN` redacted by default. **H/D** |
| Auth | `--config-dir <dir>` | Override `~/.copilot`. **H** |
| Auth (env) | `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` | First match wins; classic `ghp_` PATs **not supported**; v2 fine-grained PATs need `Copilot Requests` permission. `copilot login --help` |
| Auth (env) | `COPILOT_GH_HOST` / `GH_HOST`, `--host` | GHE.com data residency. **HE** |
| Models | `--model <name>` (env `COPILOT_MODEL`) | See §2 for full list. **H/HC** |
| Models | `--effort, --reasoning-effort <low\|medium\|high\|xhigh>` | OpenAI/Anthropic reasoning models; settings key `effortLevel`. **H/D** |
| Models | `--enable-reasoning-summaries` | Request reasoning summaries (OpenAI). **H** |
| Models (BYOK) | `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE` (`openai`/`azure`/`anthropic`), `…_API_KEY`, `…_BEARER_TOKEN`, `…_WIRE_API` (`completions`/`responses`), `…_MODEL_ID`, `…_WIRE_MODEL`, `…_MAX_PROMPT_TOKENS`, `…_MAX_OUTPUT_TOKENS`, `COPILOT_OFFLINE` | `copilot help providers` |
| Output | `--output-format <text\|json>` | `json` = JSONL (one obj/line). **H** |
| Output | `-s, --silent` | Suppresses stats/decoration; agent reply only. Pair with `-p`. **H/D** |
| Output | `--stream <on\|off>` | Streaming reply mode. **H** |
| Output | `--no-color`, `--plain-diff` (env `PLAIN_DIFF=true`) | TTY/diff rendering. **H/HE** |
| Sharing | `--share[=path]` | Markdown transcript after `-p`. Default `./copilot-session-<id>.md`. **H/D** |
| Sharing | `--share-gist` | Secret gist after `-p`. **H/D** |
| Agents | `--agent <name>` | Resolve from `.github/agents/<name>.agent.md` then `~/.copilot/agents/<name>.agent.md`. **H/D** — see §3. |
| MCP | `--additional-mcp-config <json\|@file>` (repeatable) | Augments `~/.copilot/mcp-config.json` for this session. **H** |
| MCP | `--disable-builtin-mcps` / `--disable-mcp-server <name>` | Currently the only built-in is `github-mcp-server`. **H** |
| MCP (built-in github) | `--add-github-mcp-tool <tool>` (`*` = all), `--add-github-mcp-toolset <name>` (`all`), `--enable-all-github-mcp-tools` | Default exposes only a CLI subset; these expand it. The `*`/`all` flags **override** the toolset/tool flags. **H** |
| Plugins | `--plugin-dir <dir>` (repeatable) | Load plugin from local dir. **H** |
| Lifecycle | `--no-custom-instructions` | Disable AGENTS.md / `copilot-instructions.md` loading. **H** |
| Lifecycle | `--bash-env` / `--no-bash-env` | Persists to settings. **H/HC** |
| Lifecycle | `--remote` / `--no-remote` | Allow GitHub web/mobile to drive the session. **H** |
| Lifecycle | `--log-dir <dir>`, `--log-level <none\|error\|warning\|info\|debug\|all\|default>` | **H/HL** |
| Lifecycle | `--experimental` / `--no-experimental` | Toggles experimental features. **H** |
| Lifecycle | `--no-auto-update` (env `COPILOT_AUTO_UPDATE=false`) | Auto-disabled in CI (`CI`, `BUILD_NUMBER`, `RUN_ID`, `SYSTEM_COLLECTIONURI`). **H/HE** |

**Help vs docs divergence:** docs list `read` and `memory` as `--allow-tool` kinds; `copilot help permissions` does not. Treat help as authoritative for syntax (`shell`, `write`, `url`, `<mcp>`); use docs as a hint that `read` and `memory` may be accepted in 1.0.36 but are undocumented in CLI help.

---

## 2. Models — namespace, selection, tradeoffs

Model strings the CLI accepts (verbatim from `copilot help config` under `model`):

```
claude-sonnet-4.6        claude-sonnet-4.5         claude-haiku-4.5
claude-opus-4.7          claude-opus-4.6           claude-opus-4.6-fast
claude-opus-4.5          claude-sonnet-4
gpt-5.4                  gpt-5.5                   gpt-5.3-codex
gpt-5.2-codex            gpt-5.2                   gpt-5.1
gpt-5.4-mini             gpt-5-mini                gpt-4.1
```

These are bare names — **not** the `github-copilot/<model>` namespace OpenCode uses for its own provider. Pass directly to `--model`.

**Cost / latency / quality bands (qualitative, derived from family names — not from a published rate card):**

| Tier | Models | Use for |
|---|---|---|
| Fast/cheap | `claude-haiku-4.5`, `gpt-5.4-mini`, `gpt-5-mini`, `gpt-4.1` | Summaries, code explanation, doc generation, classifications, single-file edits |
| Standard | `claude-sonnet-4`, `claude-sonnet-4.5`, `claude-sonnet-4.6`, `gpt-5.1`, `gpt-5.2`, `gpt-5.4` | General delegation default |
| Codex specialist | `gpt-5.2-codex`, `gpt-5.3-codex` | Multi-file refactors, debugging, race-condition hunting (per docs example) |
| Premium reasoning | `claude-opus-4.5/4.6/4.6-fast/4.7`, `gpt-5.5` | Architecture decisions, deep research, cross-repo migrations |

**`--effort` levels** (`low`/`medium`/`high`/`xhigh`, default `medium` via `effortLevel`): apply to extended-thinking models. Empirically the GPT-5 series and the Claude Opus / Sonnet 4.x reasoning variants honor it; lower-end models (`gpt-4.1`, mini variants, haiku) ignore it. `--enable-reasoning-summaries` is OpenAI-only per help text.

**Precedence (docs):** custom-agent `model` > `--model` > `COPILOT_MODEL` > `settings.json:model` > CLI default.

---

## 3. Custom agents (`~/.copilot/agents/<name>.agent.md`)

**File format** (`*.agent.md`, YAML frontmatter + Markdown body, body ≤30,000 chars):

```markdown
---
name: security-auditor
description: Security review specialist. Triggers on "seccheck" or audit requests.
tools: ['read', 'search', 'shell', 'github/create_issue']   # omit = all tools; [] = none
model: claude-opus-4.7                                      # optional override
mcp-servers:
  custom-mcp:
    type: local
    command: my-mcp
    args: ['--flag']
    tools: ['*']
    env:
      API_KEY: ${{ secrets.MY_KEY }}
---
You are a security auditor. Identify exposed secrets, XSS, SQLi,
vulnerable deps, and auth bypasses. For each finding, file a single
GitHub issue with risk level and recommended fix.
```

**Tool aliases** accepted in `tools:` (case-insensitive): `execute`/`shell`/`Bash`/`powershell`, `read`/`Read`/`NotebookRead`, `edit`/`Edit`/`MultiEdit`/`Write`/`NotebookEdit`, `search`/`Grep`/`Glob`, `agent`/`Task`, `web`/`WebSearch`/`WebFetch`, `todo`/`TodoWrite`. MCP tools are `<server>/<tool>` or `<server>/*`. Unknown names are silently ignored.

**Precedence** (per docs): repo `.github/agents/<name>.agent.md` > user `~/.copilot/agents/<name>.agent.md`. (Note: docs say repo wins; the create-agent UI text reverses this — "the one in your home directory will be used, rather than the one in the repository." Help text does not adjudicate. Treat repo-wins as the documented contract; treat user-wins as a possible 1.0.36 quirk and verify before relying on it.)

**Built-in agents accepted by `copilot --agent <name>`:** based on the docs ("This requires that a custom agent has been created with this name"), the `/agent` UI text ("if any"), and the user-reported rejection of `research`, **the CLI ships with no built-in agents**. Every name passed to `--agent` must resolve to a file. The plugin's current `BUILTIN_AGENTS = ['default','explore','task','general-purpose','code-review','research']` is **incorrect and stale** — these are conventions from VS Code Copilot Chat / OpenCode, not Copilot CLI. The fix: discover agents purely from `~/.copilot/agents/` + repo `.github/agents/` + plugin-installed agents (`copilot plugin install` deposits to `~/.copilot/installed-plugins/.../agents/`), and treat `--agent` without a discovered file as an error rather than offering a built-in fallback.

---

## 4. Hooks / lifecycle events

Hooks **do exist**. Two surfaces:

1. **`~/.copilot/hooks/`** (user-level scripts) and **`.github/hooks/<name>.json`** (repo-level, loaded from CWD for the CLI), schema:
   ```json
   {
     "version": 1,
     "hooks": {
       "sessionStart": [...], "sessionEnd": [...],
       "userPromptSubmitted": [...],
       "preToolUse": [...], "postToolUse": [...],
       "errorOccurred": [...]
     }
   }
   ```
   Each entry: `{ "type": "command", "bash": "...", "powershell": "...", "cwd": ".", "timeoutSec": 10, "env": {...} }`. Hooks receive a JSON event on stdin (e.g. `{"timestamp":...,"cwd":...,"toolName":...,"toolArgs":"..."}`).

2. **Inline** under `hooks` key in `~/.copilot/settings.json` (user) or `.github/copilot/settings.json` (repo). Same schema. `disableAllHooks: true` kills both.

**Event names available today (1.0.36):** `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`. Default per-hook timeout 30s.

For the plugin: hooks are a viable injection point for telemetry/audit on every spawned `copilot` subprocess without modifying the prompt.

---

## 5. MCP integration

**Config sources, in precedence order (per `copilot mcp --help`):** workspace `.mcp.json` > user `~/.copilot/mcp-config.json` > plugin-bundled. `--additional-mcp-config <json|@path>` augments for one session. Disable: `--disable-mcp-server <name>` or `--disable-builtin-mcps`. Settings keys `disabledMcpServers: []` and `enabledMcpServers: []` (the latter to opt into off-by-default built-ins like `computer-use`).

**Transports:** `stdio` (default), `http`, `sse` (`copilot mcp add --transport`).
**Env passthrough:** `--env KEY=VAL` (repeatable) on `mcp add`; values can be `${{ secrets.NAME }}` in YAML/JSON config; `--secret-env-vars` strips them from MCP child env.
**Headers (HTTP/SSE):** `--header "K: V"` repeatable; `--timeout <ms>`; `--tools "*"|csv|""`.

**Tool naming for `--allow-tool`/`--deny-tool`:** `<server-name>(<tool-name>?)`. Examples: `github(create_issue)`, `notion`. The bundled `github-mcp-server` is the only built-in MCP. Toolset granularity controlled by:
- `--add-github-mcp-tool <name>` (repeatable; `*` for all)
- `--add-github-mcp-toolset <toolset>` (repeatable; `all` for all)
- `--enable-all-github-mcp-tools` (overrides the two above)

Default exposed surface is a curated CLI subset; opt-in beyond it.

---

## 6. Multi-repo / `--add-dir`

**Default sandbox:** CWD + all subdirectories + system tempdir (the latter removable with `--disallow-temp-dir`). Anything outside (sibling repos, `~/Documents`, `/etc`, etc.) is denied without a flag.

**Expansion ladder:**
1. `--add-dir <abs-path>` (repeatable) — surgical; whitelist exact roots. Preferred for cross-repo work.
2. `--allow-all-paths` — disable verification entirely. Required when paths are unknown ahead of time.
3. `--allow-all` / `--yolo` — superset (also enables tools and URLs).

**Cross-repo patterns:**
- *Coordinated dependency bump across N repos:*
  ```bash
  copilot -p "Bump @scope/lib to 2.0 in package.json, run codemods, update tests" \
    --add-dir /repos/web --add-dir /repos/api --add-dir /repos/shared \
    --allow-all-tools --no-ask-user -s --output-format json
  ```
- *Extract shared utility into a sibling library:* `--add-dir` source repo + target repo + monorepo root; pin `--model gpt-5.3-codex`.

---

## 7. Output formats and parsing

| Mode | Stdout | Best for |
|---|---|---|
| Default text | Pretty-rendered turns + stats footer + ANSI | Human use only |
| `-s, --silent` | Final assistant reply only, no stats | Quick scripting (`var=$(copilot -p '…' -s)`) |
| `--output-format json` | **JSONL** — one JSON object per line | Programmatic consumption (the plugin's path) |

**JSONL event schema** (observed in `~/.copilot/session-state/<id>/events.jsonl`; same shape exits to stdout under `--output-format json`):

```json
{"type":"session.start","data":{"sessionId":"…","version":1,"producer":"copilot-agent","copilotVersion":"1.0.36","startTime":"…","context":{"cwd":"…"},"alreadyInUse":false,"remoteSteerable":false},"id":"…","timestamp":"…","parentId":null}
{"type":"session.model_change","data":{"newModel":"gpt-5.4"}, …}
{"type":"system.message","data":{"role":"system","content":"…"}, …}
```

Common envelope fields: `type`, `data`, `id` (uuid), `timestamp` (ISO-8601), `parentId` (null at root).

**Event types observed / inferable:** `session.start`, `session.end`, `session.model_change`, `system.message`, `user.message`, `assistant.message` (turn deltas under streaming), `tool.call.start`, `tool.call.end`, `tool.permission_request`, `error`, `notification`. Plugin parser must tolerate unknown `type` values.

**stderr** carries banners, warnings, auth prompts, update notices, and CLI errors — never JSONL events. Always merge with `2>&1` only when you don't care about clean separation; for the plugin keep them split so user-facing errors aren't mistaken for agent output.

**Parent-agent implications:** track `tool.call.*` to render live status; pair `id` with `parentId` to reconstruct the call tree for OTel propagation; capture `session.start.data.sessionId` so the parent can later `--connect=<id>` or `--resume=<id>`.

---

## 8. Auth and CI patterns

**Token precedence** (`copilot login --help`, `copilot help environment`): `COPILOT_GITHUB_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN` > stored OAuth credential (system keychain or `~/.copilot/`). Environment tokens take precedence over stored creds.

**Accepted token types:** v2 fine-grained PATs with the **`Copilot Requests`** permission, OAuth tokens from the GitHub Copilot CLI app, and OAuth tokens from the `gh` CLI app. **Classic `ghp_` PATs are explicitly unsupported** and silently fail.

**CI auto-detection** (suppresses auto-update): one of `CI`, `BUILD_NUMBER`, `RUN_ID`, `SYSTEM_COLLECTIONURI` set. Belt-and-braces: also pass `--no-auto-update` and set `COPILOT_AUTO_UPDATE=false`.

**Common CI invocation:**
```bash
COPILOT_GITHUB_TOKEN="$FG_PAT" copilot \
  -p "$PROMPT" --allow-all-tools --no-ask-user \
  --output-format json -s --no-auto-update \
  --secret-env-vars=COPILOT_GITHUB_TOKEN,NPM_TOKEN
```

**GHE.com data residency:** set `COPILOT_GH_HOST=mycompany.ghe.com` (or `--host` to `copilot login`).

**Pinning:** install via `npm i -g @github/copilot@1.0.36` (or mise `npm-github-copilot@1.0.36`) and disable auto-update so a transparent upgrade can't break the parent agent's parser.

---

## 9. Common pitfalls — silent failure modes

- **`-p` without `--allow-all-tools`** → CLI hangs on the first tool permission prompt forever (no TTY = no answer). Always pair them, or use `--allow-tool` for a tight allowlist.
- **Forgetting `--no-ask-user`** → if the agent decides it needs clarification, it invokes `ask_user` and stalls. Required for true unattended runs.
- **No `-s` under `--output-format text`** → the trailing stats banner gets piped into your downstream parser as garbage.
- **Mixing `--output-format json` with `-s`** → `-s` doesn't break JSONL, but `--no-color` is still useful; without it some events embed ANSI in `data.content`.
- **Stale `GH_TOKEN` from `gh auth login`** → `COPILOT_GITHUB_TOKEN` not set means a stale `GH_TOKEN` wins silently. Plugin should explicitly set `COPILOT_GITHUB_TOKEN` (or unset others) for predictability.
- **Classic `ghp_` PAT** → rejected with a generic auth error that doesn't mention the token-type restriction.
- **Working dir outside `--add-dir` set** → file edits fail with "path not allowed" but the agent often retries the same path 3+ times before giving up, burning tokens.
- **Auto-update mid-CI** → outside CI sentinels (custom CI?), `copilot` may download an update on first run; use `--no-auto-update`.
- **`--allow-tool='shell'` (no parens)** → matches *all* shell. To restrict you need `shell(git:*)` etc. Accidentally permissive.
- **Deny rules silently overridden by nothing** — deny always wins; if a tool seems blocked despite `--allow-all-tools`, check for an inherited `--deny-tool` from settings/agent file.
- **`--agent <name>` typo** → exits with an error ("agent not found") rather than falling back to default. There are no built-in agent names to fall back to (see §3).
- **`--add-github-mcp-toolset all` overridden by `--enable-all-github-mcp-tools`** — last-flag-wins is **not** the rule; `--enable-all-github-mcp-tools` overrides per `copilot help`. Easy to misconfigure.
- **Secrets in transcripts** — `--share`/`--share-gist` may export prompts and tool output verbatim; pair with `--secret-env-vars` and assume nothing.
- **Prompts visible in `ps`** — `copilot -p "<text>"` puts the prompt in argv. Pipe via stdin where possible (when supported) or use a wrapper that writes to a temp file and references it.
- **`parentId: null` for root events** — if your parser assumes a string, it crashes on the very first event.

---

## 10. Delegation playbook — patterns for `copilot_delegate`

Pattern matrix, each tuned for spawning from inside another agent (e.g. OpenCode primary):

### 10.1 Sandboxed targeted refactor
*When:* primary agent identified the change but wants isolation. *Prompt:* "Refactor `src/foo.ts::bar` to take a Result type; update call sites and tests; do not touch unrelated files."
*Settings:* `--model gpt-5.3-codex --add-dir <repo> --allow-tool='shell(git:*),shell(npm test),write,read' --no-ask-user --output-format json -s`. *Runtime:* 1–4 min. *Consume:* tail JSONL for `assistant.message` final + `git diff`.

### 10.2 Parallel test fixing
*When:* primary is implementing feature A; tests in module B are red. Delegate B-fix in parallel.
*Settings:* `--model gpt-5.2 --add-dir <repo> --allow-tool='shell(npm:*),shell(jest),write,read' --no-ask-user`. *Runtime:* 2–10 min. *Consume:* poll via `copilot_output`; merge result branch.

### 10.3 Multi-repo coordinated change
*When:* shared lib bump across services. *Settings:* repeated `--add-dir`; `--model gpt-5.3-codex`; allow `shell(git:*)`, `shell(pnpm:*)`. *Cost:* high — premium model, broad scope. *Consume:* per-repo summary blocks in final assistant turn.

### 10.4 Diff code review
*Prompt:* "Review the diff between `origin/main` and HEAD; surface only correctness, security, and concurrency issues; ignore style." *Settings:* `--agent code-review` if a custom agent exists, else `--model claude-opus-4.7 --effort high --allow-tool='shell(git diff),shell(git log),read'`. *Runtime:* 30–120 s. *Consume:* a single markdown report; no writes expected — set no `write` permission as a hard guard.

### 10.5 Doc generation from a module
*Prompt:* "Write a TSDoc-style overview of `src/runtime/`; include public surface table." *Settings:* `--model claude-haiku-4.5 --allow-tool='read,search,write(docs/runtime.md)' --no-ask-user -s`. *Runtime:* 20–60 s, low cost. *Consume:* the new file; primary agent can lint it.

### 10.6 Dependency / supply-chain audit
*Prompt:* "Audit `package.json` and `bun.lock` for advisories; cross-check via `gh api` and OSV." *Settings:* `--model gpt-5.4 --allow-tool='shell(npm audit),shell(bun:*),shell(gh api),url(api.github.com),url(api.osv.dev),read'`. Allow built-in github MCP for issue creation: `--add-github-mcp-tool create_issue`. *Runtime:* 1–3 min.

### 10.7 Migration / codemod authoring
*Prompt:* "Generate a jscodeshift transform that replaces `useState<T|null>(null)` with a custom `useNullable<T>` hook; include tests." *Settings:* `--model gpt-5.3-codex --effort high --add-dir <repo> --allow-tool='write,read,shell(node),shell(npx jscodeshift)'`. *Consume:* the transform script; primary applies it on demand.

### 10.8 Custom-agent specialist workflow
*When:* repo defines `.github/agents/security-auditor.agent.md`. *Settings:* `--agent security-auditor --add-dir <repo> --allow-tool='read,github(create_issue)' --deny-tool='write'`. *Consume:* GitHub issue URLs scraped from final turn.

### 10.9 Long-running codebase indexing
*When:* primary needs a structured map of an unfamiliar large repo and shouldn't block.
*Prompt:* "Produce `docs/architecture/index.md` describing every package, public symbol, and inter-module dependency." *Settings:* `--model claude-sonnet-4.6 --add-dir <repo> --allow-tool='read,search,write(docs/architecture/*)'`. Spawn detached; primary polls with `copilot_output`. *Runtime:* 5–30 min.

### 10.10 Plan-only delegation (no edits)
*When:* primary wants a second opinion before acting. *Settings:* `--mode plan --model claude-opus-4.7 --effort xhigh --allow-tool='read,search,shell(git log),shell(git status)' --deny-tool='write'`. Returns plan markdown; primary executes.

### 10.11 ACP-mediated long session
*When:* multi-turn delegation where primary wants to feed follow-up prompts. Spawn `copilot --acp …` and speak Agent Client Protocol over stdio rather than relaunching `copilot -p` per turn. Lower cold-start cost; preserves context window across turns.

### 10.12 Resume / fork pattern
*When:* prior `cpl_*` task was promising but interrupted. New delegation with `--resume=<sessionId>` + new prompt. Or `--connect=<sessionId>` to attach to a still-running task elsewhere. Useful for "continue what failed CI started."

#### 10.12a Empirical capture against CLI 1.0.40 (continuity research, 2026-05-02)

Captured for the v0.2.x continuity feature. Fixtures live at `tests/fixtures/connect-mismatch.jsonl` and `tests/fixtures/resume-mismatch.jsonl`.

**`--resume=<uuid>` behavior — surprising, by design.**

Per CLI help: *"Start a new session with a specific UUID."* Confirmed empirically:

| Target | Result | `result.sessionId` |
|---|---|---|
| Known local UUID | True continuation of prior session | Matches requested |
| **Unknown UUID** | **New session created using requested UUID as its ID** | **Matches requested (exactly)** |
| Bare `--resume` (no value) | Fresh continuation with new UUID; does NOT pick up the most-recent session in our test | New UUID |

Implication: `--resume=<unknown-uuid>` is NOT a "silent fallback" — it's an undocumented session-creation pathway that lets callers seed a session with a chosen UUID. A pre-flight `stat ~/.copilot/session-state/<uuid>/session.db` distinguishes "this is true continuity" from "this is a new session at the user-supplied UUID" — both succeed at the CLI level, but only the former is what users typically mean.

**`--connect=<uuid>` behavior with `--no-remote` — degenerate.**

`--connect` is a remote-session feature (per CLI help: *"Connect directly to a remote session"*). Combined with `--no-remote`:

| Target | Result | `result.sessionId` |
|---|---|---|
| Unknown UUID, `--no-remote` | Silent fallback — fresh local session, no error | New UUID (≠ requested) |
| Real local UUID, `--no-remote` | Same silent fallback — the connect target is ignored | New UUID (≠ requested) |

The connect target is silently ignored under `--no-remote`. There is no error, no stderr, no JSONL event indicating the mismatch — only `result.sessionId` at session end reveals the divergence. **17 events fire before `result`** in both cases, including a full `assistant.message` round-trip with whatever the prompt requested.

Implication for plugin design: `--connect` cannot be safely used in the `--no-remote` posture (which the plugin defaults to for security against third-party control). Either (a) drop `--no-remote` from connect's argv and accept the third-party-steerable risk, (b) defer `--connect` from the first slice and ship `--resume`-only, or (c) pre-flight-check that the target session is known to be remote/shared before launching. A real `--remote` connect against an active cloud session was not tested; behavior with `--remote` may differ.

**No early session-identity event during connect handshake.**

Across all 5 captures (5 different connect/resume permutations), checked every non-`result` event for `sessionId` at top level OR inside `.data`. **None present.** The `result` event is the only carrier of `sessionId`. This means there is no attach-time validation signal a plugin could use to detect a connect mismatch before tool calls or model output have already fired.

**Other surface deltas vs 1.0.34:**

- `session.mcp_servers_loaded` fires **3×** in 1.0.40 (was 1× in 1.0.34). Triplicate emission appears to be the new MCP-init pattern; treat as ephemeral and idempotent in any consumer that listens for it.
- `user.message.data.transformedContent` is **multi-line** with literal `\n` characters embedded in the JSON string value, breaking one-JSON-object-per-line parsing on that line. The parser correctly returns `{ type: 'unknown' }` for the malformed line. Real-world repro on disk in both new fixtures (line 8). This is the same upstream bug warned about for older fixtures, now reliably reproducible.

#### 10.12b Follow-up: `--connect` without `--no-remote` (CLI 1.0.40, captured 2026-05-02)

Tested whether dropping `--no-remote` from connect's argv surfaces a clean attach signal at any layer:

| Target | Argv | Result | `result.sessionId` | Stderr | Exit |
|---|---|---|---|---|---|
| Recently-completed local session | no `--no-remote` | Silent fallback, new UUID assigned | New UUID (≠ requested) | empty | 0 |
| Unknown UUID `00000000-...` | no `--no-remote` | Silent fallback, new UUID assigned | New UUID (≠ requested) | empty | 0 |

Dropping `--no-remote` does **nothing observable**. In both captures the CLI silently allocates a fresh UUID and completes a normal session at exit 0 with empty stderr. No error event in the JSONL stream, no early signal, no diagnostic. When asked the prompt *"Did this attach work? Reply with only the word YES or NO."*, the model itself replied "NO" — contextual inference, not a protocol-level signal, and not reliable as a programmatic guard.

The remote-control mechanism behind `--connect` appears to require a session that is **actively running and listening** (two concurrent processes, one providing a connection-ready session). This cannot be replicated in the plugin's one-shot `-p` execution model.

**Side finding:** `--share[=path]` is a **local markdown transcript export**, not a cloud-sharing primitive. CLI 1.0.40 has no `--share`-style remote-share flag. Any earlier assumption that `--share` produces a remotely-attachable session artifact was wrong.

**Plan implication for the v0.2.x continuity slice:** `--connect` cannot be safely shipped as a first-slice tool. There is no flag combination, argv shape, or post-launch detection mechanism (other than `result.sessionId ≠ requested` after a full run has completed) that surfaces a connect mismatch. Defer `--connect` entirely; ship `--resume`-only. If a future CLI version introduces an early attach-failure event or a protocol-level signal for "this session is not connectable," reconsider.

---

## 11. Limitations and gotchas the plugin should document

- **Prompts leak via `ps`.** `copilot -p "<prompt>"` exposes the full prompt to anyone with `ps -ef` on the host. Structurally upstream; plugin should warn in the README and consider an stdin-prompt mode if/when Copilot CLI exposes one.
- **Transcripts may leak secrets.** `--share`, `--share-gist`, and the on-disk `~/.copilot/session-state/<id>/events.jsonl` capture tool output verbatim, including env values not listed in `--secret-env-vars`. Document a default-deny posture and pre-populate `--secret-env-vars` with common names.
- **Auto-update can break the JSONL parser.** The schema is stable in 1.0.36 but the CLI auto-updates outside CI. Plugin should default `--no-auto-update` and pin via mise/nvm.
- **No built-in agents.** Plugin's `BUILTIN_AGENTS` list is wrong — `default`, `explore`, `task`, `general-purpose`, `code-review`, `research` are not shipped with `@github/copilot`. Discover only from `~/.copilot/agents/`, `.github/agents/`, and `~/.copilot/installed-plugins/*/agents/`.
- **Agent precedence ambiguity.** Docs say repo > user; the in-CLI agent-creator UI text says user > repo. Verify by experiment; for now, when both exist, log a warning and let the CLI decide (do not pre-resolve in plugin).
- **`--allow-tool=read` and `--allow-tool=memory`** are documented but not in `copilot help permissions`. **Updated 2026-05-03:** an empirical capture against 1.0.40 (see [docs/research/copilot-memory-experiment-2026-05-03.md](./copilot-memory-experiment-2026-05-03.md)) confirmed that the memory feature is exposed via a real callable tool named `store_memory`, available by default in `-p` mode without `--allow-tool=memory`. The flag is documented as a permission kind but is not enforced as a gate in 1.0.40. Treat the `read` half of this entry as best-effort and the `memory` half as resolved (the tool exists; the flag is decorative against this version). Fall back to `--available-tools`/`--excluded-tools` for hard guarantees on `read`.
- **Hooks fire for the spawned subprocess.** User-level hooks in `~/.copilot/hooks/` and inline `settings.json:hooks` will execute on every plugin-spawned session. Plugin should document this so users don't double-bill telemetry or trigger infinite loops.
- **Path sandbox is process-local.** `--add-dir` only affects the current invocation. Cross-session resume (`--resume`) does **not** persist `--add-dir`; re-pass it.
- **Tokens of type `ghp_` are silently rejected.** Plugin should detect and emit a clear `{ error: "Classic PAT not supported; use a fine-grained PAT with Copilot Requests permission." }`.
- **stderr is not JSONL.** Update notices, banners, and auth prompts are stderr-only. Plugin should pipe stderr to logs separately, never merge with stdout.
- **`--enable-all-github-mcp-tools` overrides `--add-github-mcp-toolset` / `--add-github-mcp-tool`.** Validate flag combinations before spawning; warn the caller.
- **`--no-ask-user` is the only safety against blocked sessions.** Even with `--allow-all-tools`, if the agent issues `ask_user` (e.g. ambiguous prompt), the subprocess will deadlock. Plugin should always pass `--no-ask-user` for `copilot_delegate` and document that user-question-style prompts will fail.
- **Working directory is inherited** (no `--cwd` flag). Plugin must `chdir`/`spawn({cwd})` to control where the agent operates; otherwise `--add-dir`-less invocations sandbox to wherever the parent OpenCode happened to be.
- **`--connect`/`--remote` reachability.** Sessions started with `--remote` are steerable from GitHub web/mobile; the plugin's spawn defaults should set `--no-remote` unless the user explicitly opts in, to avoid third-party control of in-flight delegations.
