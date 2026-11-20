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
├── index.ts              # Server plugin entrypoint — wires tools + RPC runtime
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
│   └── plugin-singleton.ts      # Per-process register-once guard for the plugin factory (state on `globalThis`)
├── lib/
│   ├── ansi.ts                       # `stripAnsi` — removes ANSI escape sequences from text
│   ├── errno.ts                      # `isErrnoException` type predicate for `node:fs` errors
│   ├── kill-tree.ts                  # `killProcessTree` — `fkill` wrapper that kills the process group and tolerates already-exited roots
│   ├── normalize-tool-arg-schemas.ts # Patches Zod `toJSONSchema` so tool arg descriptions survive the host/plugin zod split
│   └── rpc-cleanup.ts                # `wireRpcServerCleanup` — runs RPC server close once on `beforeExit`/`SIGTERM`
├── tui/
│   ├── index.tsx         # TUI plugin entrypoint — registers /copilot-status
│   ├── rpc-client.ts     # Reads per-session port file + calls RPC server
│   └── components/       # OpenTUI/Solid modal list + confirm card
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

- **Peer dependencies**: `@opencode-ai/plugin` is the only declared peer dependency — the host OpenCode install provides it
- **Single-line JSONL parser**: `parseJsonlLine` handles one line at a time and returns `{ type: 'unknown' }` for malformed input. Stream-level multiline accumulation belongs in the subprocess wrapper
- **Task IDs**: prefixed with `cpl_` to distinguish from OpenCode-native task IDs
- **Process cleanup**: uses `fkill` with `{ force: false, forceAfterTimeout: 2000, waitForExit: 5000 }` and `.catch()` guards on all `killProcessTree` calls in abort handlers. On macOS, `tree: true` is Windows-only, so the kill targets the entire process group via `fkill(-pid, ...)` and the subprocess is spawned with `detached: true`.
- **Notification safety**: in-flight counter is decremented synchronously (before any `await`) in close handlers; counter map entries are deleted at zero to prevent memory leaks over long-lived sessions.
- **Agent discovery**: builtin agents (bundled with Copilot CLI) cannot be overridden by user or repo agents
- **Structured errors**: tools return `{ error: string }` objects, never throw exceptions
- **Two-entrypoint architecture**: package exports the existing server plugin at `.` and `./plugin`, plus the TUI source entrypoint at `./tui`. The server half owns subprocesses, task registry, notifications, and the localhost RPC server. The TUI half is opt-in and talks to the server through the per-session authenticated port file.
- **TUI command registration**: `api.command.register` uses the `value` field for `/copilot-status` on the installed `@opencode-ai/plugin/tui` types.
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

Run `bun run lint` to check, `bun run fix` to auto-fix.

### Testing

- Framework: `bun:test`
- Pattern: arrange-act-assert with real filesystem fixtures (temp dirs)
- Subprocess tests use a fake `copilot` shell script that emits JSONL
- No mocking libraries — use plain functions and temp dirs
- Tests must be deterministic: no wall-clock timing assertions, use injected timestamps

### Commits

- Format: `feat(scope): description`, `fix(scope): description`, `chore(scope): description`
- Scopes: `runtime`, `tools`, `discovery`, `ci`, `docs`, `deps`, `dev`
- User-visible feature additions and behavior changes require a `.changeset/*.md` with `minor` bump (unstable `0.x` series). Targeted user-visible bug fixes/hotfixes may use `patch` when they do not add new functionality.

## Security Constraints

- No secrets, PATs, tokens, or PII in tool return values or log output
- Copilot CLI prompts are visible in `ps` output (upstream limitation) — avoid delegating prompts containing secrets
- Process environment is inherited from the parent OpenCode process (trusted local chain)
