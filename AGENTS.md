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
│   ├── rpc-contract.ts   # Shared server/TUI RPC schemas + inferred types
│   ├── rpc-server.ts     # localhost RPC server for the TUI half
│   ├── cancel-helper.ts  # Shared cancellation path for tool + RPC
│   ├── subprocess.ts     # Spawns copilot CLI, streams JSONL stdout
│   ├── task-registry.ts  # In-memory task state (create/get/update/delete/cleanup)
│   ├── jsonl-parser.ts   # Single-line JSONL parser for Copilot CLI output
│   ├── envelope.ts       # Builds structured output envelopes from parsed events
│   └── notify.ts         # Injects completion notifications into OpenCode sessions
├── tui/
│   ├── index.tsx         # TUI plugin entrypoint — registers /copilot-status
│   ├── rpc-client.ts     # Reads per-session port file + calls RPC server
│   └── components/       # OpenTUI/Solid modal list + confirm card
├── discovery/
│   ├── agents.ts         # Discovers .agent.md files from Copilot agent directories
│   └── description.ts    # Builds copilot_delegate tool description from discovered agents
tests/
├── jsonl-parser.test.ts  # Parser unit tests
├── envelope.test.ts      # Envelope builder tests
├── subprocess.test.ts    # Subprocess wrapper tests (fake copilot binary)
├── discovery.test.ts     # Agent discovery tests (temp fixture dirs)
├── notify.test.ts        # Notification injection tests
└── tools.test.ts         # Tool integration tests (full plugin lifecycle)
tests/fixtures/
└── jsonl/                # Real Copilot CLI JSONL captures (PII-scrubbed)
docs/
├── plans/                # Implementation plans for major work
└── solutions/            # Documented solutions to past problems (bugs, best practices, workflow patterns), organized by category with YAML frontmatter (module, tags, problem_type)
```

## Design Decisions

- **Peer dependencies**: `@opencode-ai/plugin` and `@opencode-ai/sdk` are peers — the host OpenCode install provides them
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
- Scopes: `runtime`, `tools`, `discovery`, `ci`, `docs`
- User-visible feature additions and behavior changes require a `.changeset/*.md` with `minor` bump (unstable `0.x` series). Targeted user-visible bug fixes/hotfixes may use `patch` when they do not add new functionality.

## Security Constraints

- No secrets, PATs, tokens, or PII in tool return values or log output
- Copilot CLI prompts are visible in `ps` output (upstream limitation) — avoid delegating prompts containing secrets
- Process environment is inherited from the parent OpenCode process (trusted local chain)
