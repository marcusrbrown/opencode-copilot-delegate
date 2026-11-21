# AGENTS.md

## What This Project Is

`opencode-copilot-delegate` is an OpenCode plugin that spawns GitHub Copilot CLI (`copilot -p`) as background subprocesses. It exposes four tools to OpenCode sessions:

- **`copilot_delegate`** — Spawn a Copilot CLI subprocess with a prompt and optional agent/model
- **`copilot_output`** — Retrieve results from a running or completed delegation (supports blocking with timeout)
- **`copilot_cancel`** — Cancel a running delegation and kill its process tree
- **`copilot_resume`** — Resume a prior Copilot session by UUID, name, or prefix (`copilot --resume=<target_id>`)

## Architecture

```
src/
├── index.ts              # Dual-host entry: default `{ id, server, setup }` only (V1 reads `server`, V2 reads `setup`); typed without host packages
├── hosts/
│   ├── v1.ts             # `serverV1`: acquire process core (never released), per-directory hooks via `plugInOnce`, normalized arg schemas
│   └── v2.ts             # `setupV2`: reduced-bridge guard, `tool.transform` + `tools.add` (zod as Standard Schema, unnormalized), `session.synthetic` notices, cleanup releases the core
├── core/
│   ├── tools.ts          # `buildTools`: the four tools for one workspace, shared by both hosts
│   └── process.ts        # `initializeProcess`: orphan reap + RPC server; returns the release teardown (cancel tasks → close RPC → truncate ledger)
├── tools/
│   ├── delegate.ts       # copilot_delegate tool
│   ├── output.ts         # copilot_output tool
│   ├── cancel.ts         # copilot_cancel tool
│   └── resume.ts         # copilot_resume tool
├── runtime/
│   ├── rpc-contract.ts          # Shared server/TUI RPC schemas + inferred types
│   ├── rpc-server.ts            # localhost RPC server for the TUI half
│   ├── cancel-helper.ts         # Shared cancellation path for tool + RPC
│   ├── subprocess.ts            # Spawns copilot CLI, streams JSONL stdout
│   ├── task-registry.ts         # In-memory task state (create/get/update/delete/cleanup)
│   ├── task-status.ts           # `setStatus` forward-only lifecycle; terminal states are idempotent
│   ├── jsonl-parser.ts          # Single-line JSONL parser for Copilot CLI output
│   ├── envelope.ts              # Builds structured output envelopes from parsed events
│   ├── notify.ts                # Injects completion notifications into OpenCode sessions
│   ├── continuity-checks.ts     # Resume/connect helpers: session UUID check, local session-state lookup, CLI error normalization
│   ├── continuity-validation.ts # Validates resume target IDs, `--add-dir` paths, and cwd against allowed roots (realpath-aware)
│   ├── orphan-reaper.ts         # Startup reaper: kills orphaned Copilot process trees found in per-instance PID files (liveness + identity gates)
│   ├── pid-file.ts              # Per-instance PID file I/O (serialized append/remove/truncate, symlink-safe)
│   ├── plugin-singleton.ts      # `plugInOnce`: hooks once per directory; `{}` for duplicate config sources (V1)
│   └── process-core.ts          # `acquireProcessCore`/`releaseProcessCore`: ref-counted process resources; last release tears down once, acquire waits on a pending release
├── lib/
│   ├── ansi.ts                       # `stripAnsi` — removes ANSI escape sequences from text
│   ├── errno.ts                      # `isErrnoException` type predicate for `node:fs` errors
│   ├── kill-tree.ts                  # `killProcessTree` — `fkill` wrapper that kills the process group and tolerates already-exited roots
│   ├── normalize-tool-arg-schemas.ts # Patches Zod `toJSONSchema` so tool arg descriptions survive the host/plugin zod split
│   ├── process-global.ts             # `processGlobal` — `Symbol.for`-keyed `globalThis` slots so state is shared across module instances (registry, PID write chains, in-flight counters)
│   ├── rpc-cleanup.ts                # `wireRpcServerCleanup` — runs RPC server close once on `beforeExit`/`SIGTERM`
│   └── tool.ts                       # Host-free `tool()` + bundled zod; host packages are type-only imports (no runtime host import in dist)
├── tui/
│   ├── index.tsx         # TUI entrypoint `{ id, tui, setup }` — V1 `tui` and V2 `setup` both register /copilot-status (palette + slash)
│   ├── status-dialogs.tsx # V1 flow on host DialogSelect/DialogConfirm/DialogAlert (host owns theming, keys, close)
│   ├── status-flow-v2.ts  # V2 flow on `ctx.ui.dialog.select/confirm/alert` (promise dialogs, no JSX, no clear/onClose)
│   ├── status-format.ts  # Pure formatting helpers for task option text (status, elapsed, tool calls)
│   └── rpc-client.ts     # Reads the port file (V1: session id; V2: server pid, re-read per request) + calls RPC server
├── discovery/
│   ├── agents.ts         # Discovers .agent.md files from Copilot agent directories
│   └── description.ts    # Builds copilot_delegate tool description from discovered agents
tests/
├── *.test.ts             # Unit tests, roughly one per src module (parser, envelope, subprocess, discovery, notify, RPC, reaper, tools, package exports, ...)
├── integration/          # Integration tests against the built plugin + a real `opencode` CLI (skipped when absent)
└── fixtures/             # Test inputs: JSONL captures (PII-scrubbed Copilot CLI output), agent .md fixtures, README with provenance
src/tui/__tests__/        # TUI tests (components, RPC client, plugin entrypoint)
docs/
├── brainstorms/          # Requirements documents from brainstorming sessions
├── ideation/             # Improvement ideation write-ups
├── plans/                # Implementation plans for major work
├── research/             # Research notes (Copilot CLI capabilities, experiments)
└── solutions/            # Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (module, tags, problem_type)
```

## Design Decisions

- **Peer dependencies**: `@opencode-ai/plugin` (OpenCode 1.x) and `@opencode/plugin` (2.x) are both optional peers, and the host install provides whichever applies. Both are type-only imports, so `dist/index.js` loads on either host without the other's package. `@opentui/core`, `@opentui/solid` and `solid-js` are dev dependencies (types, tests, build transform) plus optional peers: both hosts resolve the externalized imports to their own copies at runtime, so they are not shipped. Keep them external in `scripts/build.ts`.
- **Single-line JSONL parser**: `parseJsonlLine` handles one line at a time and returns `{ type: 'unknown' }` for malformed input. Stream-level multiline accumulation belongs in the subprocess wrapper
- **Task IDs**: prefixed with `cpl_` to distinguish from OpenCode-native task IDs
- **Process cleanup**: uses `fkill` with `{ force: false, forceAfterTimeout: 2000, waitForExit: 5000 }` and `.catch()` guards on all `killProcessTree` calls in abort handlers. On macOS, `tree: true` is Windows-only, so the kill targets the entire process group via `fkill(-pid, ...)` and the subprocess is spawned with `detached: true`.
- **Notification safety**: in-flight counter is decremented synchronously (before any `await`) in close handlers; counter map entries are deleted at zero to prevent memory leaks over long-lived sessions.
- **Agent discovery**: builtin agents (bundled with Copilot CLI) cannot be overridden by user or repo agents
- **Structured errors**: tools return `{ error: string }` objects, never throw exceptions
- **Two-entrypoint architecture**: package exports the existing server plugin at `.` and `./plugin`, plus the TUI source entrypoint at `./tui`. The server half owns subprocesses, task registry, notifications, and the localhost RPC server. The TUI half is opt-in and talks to the server through the per-session authenticated port file.
- **TUI discovery (V2)**: the V2 TUI is a separate process from the server with no `OPENCODE_SESSION_ID`. The server keys its port file by its own pid (`serverPidDiscriminator`), and the TUI reads the pid from `ctx.client.server.info()` (`discriminatorForServer`, which refuses a server whose `hostname` isn't this machine). Every discriminator is checked with `assertSafeSessionDiscriminator` before it becomes a path.
- **TUI command registration**: on V2, `ctx.keymap.layer` registers a named command (`palette: true`, `slash`) and the layer must set `mode: 'global'`, or it never reaches the prompt's `/` menu. On V1, `api.keymap.registerLayer` registers a `palette` command with `slashName: 'copilot-status'` and `desc`; the legacy `api.command.register` fallback uses the `value` field plus `slash` for hosts without the keymap surface.
- **TUI dialogs**: `/copilot-status` is built only from host dialogs so theming and keys come from the host. V1 uses components (`api.ui.DialogSelect`, `DialogConfirm`, `DialogAlert`): never call `api.ui.dialog.clear()` or pass `onClose` to `dialog.replace`, and open follow-up dialogs on a deferred tick (the host clears `DialogConfirm`/`DialogAlert` itself after `onConfirm`/`onCancel`). V2 uses the promise dialogs `ctx.ui.dialog.select/confirm/alert` in one sequential flow, with the same no-`clear()`/no-`onClose` rule; `dialog.set({ size })` must come after the dialog is shown, because `show` resets the size. Esc on either host's confirm is host-owned: it closes the dialog and ends the flow (only the Cancel button returns to the list). See `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md`.
- **TUI JSX mode**: `tsconfig.json` keeps `jsx: "preserve"`; TUI `.tsx` files use `/** @jsxImportSource @opentui/solid */` pragmas.

## Coding Standards

### TypeScript

- Strict mode (`strict: true` in tsconfig)
- No `as any`, `@ts-ignore`, or `@ts-expect-error`
- Prefer `satisfies` over type annotations when you want inference
- Discriminated unions over optional properties
- `const` assertions for literal types
- ESM imports only (this is a `"type": "module"` package)

### Formatting and Linting

Biome handles both. Configuration in `biome.json`:

- 2-space indent, single quotes, no semicolons (ASI)
- Recommended lint rules enabled
- Formatting is off for `docs/**/*.md`, and `CHANGELOG.md` is excluded, because Biome's markdown formatter corrupts YAML frontmatter and rejects changeset-generated lists. `tests/docs-frontmatter.test.ts` checks that every docs frontmatter block parses

Run `bun run lint` to check, `bun run fix` to auto-fix.

### Testing

- Framework: `bun:test`
- Pattern: arrange-act-assert with real filesystem fixtures (temp dirs)
- Subprocess tests use a fake `copilot` shell script that emits JSONL
- No mocking libraries — use plain functions and temp dirs
- Tests must be deterministic: no wall-clock timing assertions, use injected timestamps
- Process-wide state lives on `globalThis` (process core, hook guards, registry), so tests that touch it reset it in both `beforeEach` and `afterEach`; bun's file order differs between machines
- Gates: `bun run test:unit` and `bun run test:tui` both run in CI. The `Host contract matrix` CI check (`tests/host-contract/run-host.sh <pin>`, pins in `scripts/opencode-host-pins.json`) installs the packed plugin next to each real host (V1 floor, V1 current, V2) and needs no model; run it locally for host-contract changes

### Commits

- Format: `feat(scope): description`, `fix(scope): description`, `chore(scope): description`
- Scopes: `runtime`, `tools`, `discovery`, `ci`, `docs`, `deps`, `dev`
- User-visible feature additions and behavior changes require a `.changeset/*.md` with `minor` bump (unstable `0.x` series). Targeted user-visible bug fixes/hotfixes may use `patch` when they do not add new functionality.

## Security Constraints

- No secrets, PATs, tokens, or PII in tool return values or log output
- Copilot CLI prompts are visible in `ps` output (upstream limitation) — avoid delegating prompts containing secrets
- Process environment is inherited from the parent OpenCode process (trusted local chain)
