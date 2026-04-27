# opencode-copilot-delegate

## 0.1.0

### Minor Changes

- bea3f57: Initial v0.1.0 bootstrap: package scaffold, TypeScript config, and `src/` module structure for the OpenCode Copilot delegate plugin.
- f85c8d8: Add LLM-driven integration tests covering the three plugin tools end-to-end. A real OpenCode session driven via `opencode run` and a paid LLM model invokes `copilot_delegate`, `copilot_output`, and `copilot_cancel` against real Copilot subprocesses, with assertions on the textual response. Three scenarios cover task-id format from `copilot_delegate`, the `unknown` status path through `copilot_output` for a nonexistent task id, and `copilot_cancel` against a running delegation.

  Tests run against `opencode/minimax-m2.5` by default (override with `OPENCODE_TEST_MODEL`). The describe block is gated on either `GH_TOKEN` or `COPILOT_PAT` being set; when neither is present, the suite skips cleanly so `bun test` stays green on dev machines without a Copilot PAT. Per-test isolation uses `OPENCODE_CONFIG_DIR` pointed at an empty temp dir to skip the developer's globally-configured plugins, and `OPENCODE_CONFIG_CONTENT` to register the plugin's own `dist/index.js` as a `file://` plugin in each test session.

- 79d1f09: Add JSONL parser and envelope builder for Copilot CLI output processing

  - `parseJsonlLine()` normalizes Copilot CLI JSONL events into typed `ParsedEvent` objects with defensive handling of malformed input
  - `buildEnvelope()` folds parsed events into the structured `copilot_output` response shape with graceful degradation for missing fields
  - Live JSONL fixtures captured from `copilot` CLI v1.0.34 for regression testing

- de20762: Document the upstream `ps`/prompt-visibility caveat, the absence of a subprocess lifetime cap, and the `0.x` versioning policy in the README. Correct the notification-injection description to match the implementation (`client.session.prompt` with `noReply`, not `promptAsync`).
- a23e15f: Add automated release pipeline. A new `Release` workflow runs after the `CI` workflow succeeds on `main`, opens a "Version Packages" pull request via `changesets/action` when changesets are pending, and publishes to npm via OIDC trusted publishing once that PR merges. Adds `@changesets/cli` as a development dependency and the `version-changesets` and `publish-changesets` scripts to drive the version-bump and publish steps.
- 6fd4c6d: Add subprocess wrapper, task registry, notification injection, and agent discovery

  - Subprocess spawning with line-buffered JSONL parsing, auth token env precedence, and abort-based cancellation via fkill process group kills
  - In-memory task registry with cleanup-all lifecycle
  - Notification injection using noReply semantics with per-session in-flight counters
  - Agent discovery scanning builtin, user, and repo directories with override semantics
  - ANSI escape sequence stripping for clean error/message text

- fcc52ac: Wire copilot_delegate, copilot_output, and copilot_cancel tools into the plugin entrypoint with subprocess lifecycle management, notification injection, and structured error handling.

### Patch Changes

- 842fcd6: Add Renovate configuration and workflow for automated dependency updates.
