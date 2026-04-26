# AGENTS.md

## What This Project Is

`opencode-copilot-delegate` is an OpenCode plugin that spawns GitHub Copilot CLI (`copilot -p`) as background subprocesses. It exposes three tools to OpenCode sessions:

- **`copilot_delegate`** — Spawn a Copilot CLI subprocess with a prompt and optional agent/model
- **`copilot_output`** — Retrieve results from a running or completed delegation (supports blocking with timeout)
- **`copilot_cancel`** — Cancel a running delegation and kill its process tree

## Architecture

```
src/
├── index.ts              # Plugin entrypoint — wires tools to runtime
├── tools/
│   ├── delegate.ts       # copilot_delegate tool
│   ├── output.ts         # copilot_output tool
│   └── cancel.ts         # copilot_cancel tool
├── runtime/
│   ├── subprocess.ts     # Spawns copilot CLI, streams JSONL stdout
│   ├── task-registry.ts  # In-memory task state (create/get/update/delete/cleanup)
│   ├── jsonl-parser.ts   # Single-line JSONL parser for Copilot CLI output
│   ├── envelope.ts       # Builds structured output envelopes from parsed events
│   └── notify.ts         # Injects completion notifications into OpenCode sessions
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
```

## Design Decisions

- **Peer dependencies**: `@opencode-ai/plugin` and `@opencode-ai/sdk` are peers — the host OpenCode install provides them
- **Single-line JSONL parser**: `parseJsonlLine` handles one line at a time and returns `{ type: 'unknown' }` for malformed input. Stream-level multiline accumulation belongs in the subprocess wrapper
- **Task IDs**: prefixed with `cpl_` to distinguish from OpenCode-native task IDs
- **Process cleanup**: uses `fkill` with `{ force: false, forceAfterTimeout: 2000, waitForExit: 5000 }` and `.catch()` guards on all `killProcessTree` calls in abort handlers. On macOS, `tree: true` is Windows-only, so the kill targets the entire process group via `fkill(-pid, ...)` and the subprocess is spawned with `detached: true`.
- **Notification safety**: in-flight counter is decremented synchronously (before any `await`) in close handlers; counter map entries are deleted at zero to prevent memory leaks over long-lived sessions.
- **Agent discovery**: builtin agents (bundled with Copilot CLI) cannot be overridden by user or repo agents
- **Structured errors**: tools return `{ error: string }` objects, never throw exceptions

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
- User-visible changes require a `.changeset/*.md` with `minor` bump (unstable `0.x` series)

## Security Constraints

- No secrets, PATs, tokens, or PII in tool return values or log output
- Copilot CLI prompts are visible in `ps` output (upstream limitation) — avoid delegating prompts containing secrets
- Process environment is inherited from the parent OpenCode process (trusted local chain)
