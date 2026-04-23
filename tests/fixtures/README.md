# JSONL Test Fixtures

Captured from live `copilot` CLI output for testing the JSONL parser.

## Provenance

- **CLI version:** GitHub Copilot CLI 1.0.34
- **Capture date:** 2026-04-23
- **Model:** `claude-haiku-4.5` (happy-path, multi-tool); `nonexistent-model-xyz-404` (model-error)
- **Command pattern:** `copilot -p "<prompt>" --output-format json -s --allow-all-tools --no-ask-user --model <model>`

## Fixtures

### `happy-path.jsonl` (70 lines)

Simple prompt: "Read README.md and summarize in 2 sentences". Single tool call (`view`), successful completion. All lines are valid JSON.

### `model-error.jsonl` (1 line)

Invalid model name triggers immediate exit. Only a single `session.mcp_server_status_changed` event is emitted before the CLI exits with non-zero code. The error message goes to stderr, not JSONL.

### `multi-tool.jsonl` (90 lines)

Prompt: "List all files in the src/ directory, then read package.json and tell me the package name". Multiple tool calls (`glob`, `view`), successful completion.

**Note:** All lines are valid JSON. Copilot CLI may in some scenarios emit unescaped newlines inside JSON string values, which would break the one-JSON-object-per-line contract. If encountered at runtime, the parser returns `{ type: 'unknown' }` for malformed lines. Stream-level recovery (bracket-counting accumulation) is planned for the subprocess wrapper.

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
