# opencode-copilot-delegate

## 0.3.0

### Minor Changes

- 7dfb029: Eliminate head-of-line blocking and halve fork/exec cost in the orphan reaper

  Two performance improvements to the plugin-init orphan-subprocess reaper, both surfaced in the `v0.1.x / v0.2.x runtime hardening follow-ups` tracking issue:

  - **Streaming worker pool replaces chunked `Promise.all`**: under loaded conditions a single slow `ps` invocation (300-500ms is realistic) used to idle four sibling workers in the same chunk, blowing the soft init budget by 5-10x. The reaper now spawns up to `MAX_CONCURRENT_PROBES = 5` workers that drain a shared queue independently — a slow probe blocks only its own worker.
  - **Combined `ps -p <pid> -o comm=,lstart=` query**: the two separate `comm` and `lstart` lookups (per entry, plus per task spawn) consolidate into a single `getPidIdentity(pid)` call. Halves fork/exec cost on the reap hot path, makes the concurrency-cap math match reality (5 workers ⇒ at most 5 concurrent `ps` subprocesses, not 10), and gets an atomic kernel snapshot of both identity legs.

  Net wall-clock impact for a 10-entry orphan file with one slow `ps` probe: the chunked-of-5 worst case (~210ms) drops to roughly 200ms, but the streaming pool eliminates the artificial wave-boundary stall — the 9 fast probes complete in ~30ms instead of being trapped behind the slow one.

  No public API changes. All callers and tests updated to use the combined `getPidIdentity` dependency.

## 0.2.0

### Minor Changes

- e2ea508: Add an orphan subprocess reaper that runs at plugin init to clean up `copilot` subprocesses left behind when the plugin reloads or the OpenCode session exits unexpectedly.

  The reaper writes a per-instance PID file at `<XDG_STATE_HOME>/opencode-copilot-delegate/orphans/<plugin-pid>.pids` for every subprocess the plugin spawns and removes the entry on every terminal status transition (complete, failed, cancelled). On the next plugin init, the reaper scans the orphans directory, probes the owning plugin's liveness for each foreign file (`process.kill(<plugin-pid>, 0)`), reaps entries from files whose plugin has exited (and deletes those files), and skips entries from files whose plugin is still running.

  Identity gate is strict: each kill requires the live process's `comm` (kernel-tracked executable name from `ps -o comm=`) AND `lstart` (start-time string) to match values recorded at spawn time. Combined with the spawner-liveness probe, this prevents both PID-reuse-of-an-unrelated-process and cross-instance kill of a live foreign instance's children.

  Also fixes a parser cancel-race in the JSONL data handler — events buffered before the abort listener fired could previously be appended to `task.events` after `task.status` had been set to `cancelled`. The fix is a one-line `if (task.status !== 'running') break` guard at the top of the per-line loop, before `parseJsonlLine`.

  The new `setStatus` helper centralizes the three terminal status mutations in `subprocess.ts` (close event, abort listener, spawn error) along with the `removePidEntry` cleanup hook. It is idempotent on terminal state — once `task.status` is terminal, subsequent `setStatus` calls with another terminal value no-op, preserving the existing `finalizeTask` `if (task.status !== 'cancelled')` invariant automatically.

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
