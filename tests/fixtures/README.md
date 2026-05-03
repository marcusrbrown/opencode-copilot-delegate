# JSONL Test Fixtures

Captured from live `copilot` CLI output for testing the JSONL parser.

## Provenance

| Fixture | CLI version | Capture date | Notes |
|---|---|---|---|
| `happy-path.jsonl`, `multi-tool.jsonl`, `model-error.jsonl` | 1.0.34 | 2026-04-23 | Original parser-test set; `--model` switching variants |
| `connect-mismatch.jsonl`, `resume-mismatch.jsonl` | 1.0.40 | 2026-05-02 | Continuity-feature research captures (Unit 3a) |

**Command patterns:**
- Original (1.0.34): `copilot -p "<prompt>" --output-format json -s --allow-all-tools --no-ask-user --model <model>`
- Continuity (1.0.40): `copilot --connect=<id>` or `--resume=<id>` plus the same flags, with `--no-remote` added.

## Fixtures

### `happy-path.jsonl` (70 lines)

Simple prompt: "Read README.md and summarize in 2 sentences". Single tool call (`view`), successful completion. All lines are valid JSON.

### `model-error.jsonl` (1 line)

Invalid model name triggers immediate exit. Only a single `session.mcp_server_status_changed` event is emitted before the CLI exits with non-zero code. The error message goes to stderr, not JSONL.

### `multi-tool.jsonl` (90 lines)

Prompt: "List all files in the src/ directory, then read package.json and tell me the package name". Multiple tool calls (`glob`, `view`), successful completion.

**Note:** All lines are valid JSON. Copilot CLI may in some scenarios emit unescaped newlines inside JSON string values, which would break the one-JSON-object-per-line contract. If encountered at runtime, the parser returns `{ type: 'unknown' }` for malformed lines. Stream-level recovery (bracket-counting accumulation) is planned for the subprocess wrapper. The continuity captures (`connect-mismatch.jsonl`, `resume-mismatch.jsonl`) contain a real-world repro of this on line 8 (the `user.message` event's `transformedContent` field carries literal `\n` characters as actual newlines).

### `connect-mismatch.jsonl` (18 lines, line 8 invalid by design)

Command: `copilot --connect=00000000-... --no-remote -p "noop" --output-format json -s --allow-all-tools --no-ask-user`. Demonstrates the **silent-fallback** behavior of `--connect` when combined with `--no-remote`: the requested session ID is ignored and a fresh local session is created with a new UUID. Used by the continuity tools to motivate why connect requires careful tool-description warning rather than pre-launch validation. Exit code 0; empty stderr; `result.sessionId` does NOT match the requested `00000000-...` ID. 17 events fire before `result`.

### `resume-mismatch.jsonl` (18 lines, line 8 invalid by design)

Command: `copilot --resume=00000000-... --no-remote -p "noop" --output-format json -s --allow-all-tools --no-ask-user`. Demonstrates the **UUID-as-session-ID** behavior of `--resume`: when given a previously-unknown UUID, the CLI creates a new session that uses the requested UUID as its session ID (per CLI help: "Start a new session with a specific UUID"). Exit code 0; empty stderr; `result.sessionId` matches the requested ID exactly. The pre-flight `hasLocalCopilotSession` check distinguishes "resume continuation" (existing UUID) from "new session at user-supplied UUID" (unknown UUID) — both succeed at the CLI level, but only the former is true continuity.

## Sanitization

- All paths under `$HOME` replaced with `$HOME` literal.
- Session UUIDs and timestamps are left as-is (not PII).

## Event Types Observed

| Type | Description | Ephemeral |
|------|-------------|-----------|
| `session.mcp_server_status_changed` | MCP server connected | Yes |
| `session.mcp_servers_loaded` | All MCP servers loaded | Yes |
| `session.skills_loaded` | Skills discovered | Yes |
| `session.tools_updated` | Tools updated with model | Yes |
| `user.message` | User prompt with transformed content | No |
| `assistant.turn_start` | Turn begins | No |
| `assistant.reasoning_delta` | Streaming reasoning chunk | Yes |
| `assistant.reasoning` | Full reasoning content | Yes |
| `assistant.message_delta` | Streaming message chunk | Yes |
| `assistant.message` | Complete message with tool requests | No |
| `tool.execution_start` | Tool invocation begins | No |
| `tool.execution_complete` | Tool result returned | No |
| `assistant.turn_end` | Turn ends | No |
| `result` | Session summary with usage stats | No |
