# opencode-copilot-delegate

## 0.10.1

### Patch Changes

- 98a827e: Fix the `/copilot-status` TUI freeze caused by re-entrant dialog close handling when pressing Escape.

## 0.10.0

### Minor Changes

- e84f127: Prepare the package for an optional Copilot status TUI by adding server and TUI plugin metadata plus dedicated package exports.

## 0.9.0

### Minor Changes

- 80b549e: Improve runtime observability and fix a silent failure in completion notifications.

  - `killProcessTree` now classifies fkill failures by probing the process group with `process.kill(-pid, 0)`. ESRCH is reported as an already-gone group and the failure is suppressed; alive or unknown states preserve the original throw with a more accurate warning. The probe targets `-pid` (the process group) rather than the leader so children leaking after a leader exit are no longer misclassified as benign.
  - `notifyCompletion`'s fallback `client.app.log` call now uses the structured SDK shape (`{ body: { service, level, message } }`) and is wrapped in `try/catch` so synchronous SDK throws can no longer escape the documented "never throws" contract.
  - All runtime warnings now share the `[copilot-delegate]` prefix across `kill-tree`, `orphan-reaper`, `pid-file`, `task-registry`, and `task-status`, making operator log filtering predictable.
  - Internal contract documentation: `setStatus` and `writeChains` carry JSDoc covering terminal-state transitions and the per-file serialize chain.

- 4f2e8b5: Harden PID file and orphan-reaper state path handling against same-user symlink attacks.

  - Use no-follow PID file opens for read and truncate paths so symlinked `.pids` files are rejected instead of read or truncated.
  - Reject symlinked PID file parent directories before orphan reaping, cleanup, and plugin init state-directory creation so `orphans/` scans and cleanup do not follow attacker-controlled links.

## 0.8.0

### Minor Changes

- 0c21f43: Make the plugin factory idempotent across multiple OpenCode config sources within the same process. When `~/.config/opencode/opencode.json` AND a project-level `opencode.json` (or any other combination of config sources) both list `opencode-copilot-delegate`, OpenCode previously invoked the factory once per source — each invocation evaluating the plugin module fresh, running orphan reaping, and registering its own copy of the three tools. The result was duplicated tools in the catalog, duplicated init side effects (PID-file `mkdir`, `reapOrphans`), and per-invocation closure state that could diverge across registrations.

  The factory now resolves at most once per process via a `globalThis` symbol singleton (`Symbol.for('opencode-copilot-delegate.singleton.v1')`). Subsequent invocations within the same PID return the cached hooks promise, skip the heavy init, and emit a single one-shot warning (via `console.warn` AND `client.app.log` under `service=copilot-delegate`) so duplicate-config situations remain observable in logs. Across distinct OpenCode processes the singleton is fresh — each process initializes normally.

  No configuration change is required for users with a single config source. Users with duplicate registrations will see one warning per process and a single set of tools in the catalog.

- 1fc343d: Tighten orphan-reaper internals and add two new exported helpers from `src/runtime/pid-file.ts`:

  - `truncatePidFile(filePath)` — truncate under the per-file `serializeWrite` lock; ENOENT (file or parent missing) silently swallowed.
  - `unlinkPidFile(filePath)` — unlink under the per-file `serializeWrite` lock; ENOENT silently swallowed.

  Also export `ReapOptions` from `src/runtime/orphan-reaper.ts` (consolidates `ReapDeps` + reap-specific opts via interface extension), and consolidate `reapOneFile` to a single opts-bag parameter. `cleanupAfterReap` now routes its truncate-on-current and unlink-on-foreign paths through the new helpers so any future change that runs reap concurrent with task spawns is automatically race-safe.

  No user-visible behavior change in default usage; the bump reflects the new exported surface.

- 42c5239: Add `timedOut: boolean` to `ReapResult` so consumers can distinguish a successful no-op reap (nothing to do) from a timeout-aborted reap (gave up; orphans may remain). The flag is `false` on every success path and `true` only when the overall `reapOrphans` timeout fires.

  When `timedOut` is `true`, the count fields are zero placeholders, not partial-progress accounting — in-flight workers may have already invoked `killProcessTree` or scanned files before the abort signal landed, but those side effects are not reflected in the returned counts. Treat a timed-out result as "no reliable count signal" and warn or retry.

  Note for TypeScript consumers: `ReapResult` is exported from the package's runtime types and gains a required field. Any caller constructing a `ReapResult` literal will need to add `timedOut` explicitly. Internal callers in this repo are already updated.

- 3491e63: Tighten the `setStatus` lifecycle helper to forbid terminal → non-terminal transitions. Once a task reaches `complete`, `failed`, or `cancelled`, every subsequent `setStatus` call is a no-op. Previously the helper short-circuited only when both old and new status were terminal, leaving an unintended resurrection path that no caller exercises but the contract permitted. This narrows the public API contract; no caller behavior changes.

## 0.7.0

### Minor Changes

- 3f8b78e: Surface per-parameter `.describe()` text to the host runtime by patching each tool arg schema with a `_zod.toJSONSchema` override.

  OpenCode's tool catalog renders plugin schemas via the host's bundled zod, which lives in a different module instance from the plugin's zod and cannot see the plugin-side `.describe()` metadata registry. The override delegates serialization back to the plugin-local zod so descriptions survive intact, mirroring the pattern shipped by `@cortexkit/opencode-magic-context` and `@cortexkit/aft-opencode`.

  Also pins `zod` as a direct dependency (`^4.3.0`) with a matching `overrides` entry to keep this repo's dependency tree on a single zod version, resolving a TS2883 unportable-inferred-type error from two zod trees coexisting at build time. The `overrides` field is local to this repo's installs only; npm ignores it for downstream consumers, so external plugin authors importing this package may still see a different transitive zod from their OpenCode host. Also reverts the prior schema-chain reorder since the override makes ordering irrelevant.

## 0.6.0

### Minor Changes

- e0480fe: Surface per-parameter descriptions to host LLMs and drop the unused `@opencode-ai/sdk` peer dependency.

  OpenCode's tool-list endpoint serializes plugin schemas with Zod's `toJSONSchema(..., { io: 'input' })` mode, which unwraps `.optional()` wrappers and drops any `.describe()` text attached to the wrapper. The 5 optional parameters across `copilot_delegate` and `copilot_output` chained `.optional().describe(...)` and lost their descriptions in the rendered tool catalog. Reordering to `.describe(...).optional()` places the description on the leaf type so it survives the unwrap.

  Also drops `@opencode-ai/sdk` from `peerDependencies` and the build externals — the package was never imported from any source file, so the peer requirement was dead config that forced consumers to install an unused dependency.

## 0.5.0

### Minor Changes

- e940a28: Drop `BUILTIN_AGENTS` and enrich tool schema descriptions

  **`BUILTIN_AGENTS` removal.** The plugin previously advertised six "built-in" agent names — `default`, `explore`, `task`, `general-purpose`, `code-review`, `research` — inherited from VS Code Copilot Chat / OpenCode conventions. The standalone `@github/copilot` CLI v1.0.36 ships zero of these; passing any of them as `--agent <name>` causes Copilot CLI to fail at spawn time with `Error: No such agent: <name>, available:`. The constant has been removed. `discoverAgents` now returns user agents (filtered by repo override) followed by repo agents; `Agent.source` is `'user' | 'repo'`. `buildDescription` handles the empty-discovery case by emitting an actionable hint pointing at `~/.copilot/agents` and `.github/agents`.

  **Tool schema enrichment.** The three exposed tools — `copilot_delegate`, `copilot_output`, `copilot_cancel` — now ship multi-paragraph tool descriptions covering what they do, when to use them, lifecycle, common pitfalls, and return-value shape. Per-parameter `.describe()` text spells out type, default, when-required, example values, and constraints. Examples follow the patterns Magic Context's `ctx_*` tools established. The new descriptions surface in OpenCode's tool registry exposure to LLMs and via `mise run opencode:doctor --only tools`.

  No runtime behavior change beyond the agent discovery fix. Tool argument shapes are unchanged; existing callers continue to work without modification.

## 0.4.0

### Minor Changes

- f3f21c7: Configurable orphan-reaper timeouts and parser extraction

  Three medium-priority improvements to the plugin-init orphan-subprocess reaper, all from the runtime hardening backlog:

  - **Configurable per-probe `ps` timeout with degradation warning**: `getPidIdentity` and the underlying `runPs` helper now accept an optional `timeoutMs` parameter (default 1000). On loaded systems where legitimate `ps` responses can exceed 1s, callers can pass a longer timeout to avoid identity-gate misses that leave orphans alive. When the timeout fires, `runPs` emits a `console.warn` so operators can detect probe degradation and tune the budget up.
  - **Overall `reapOrphans` timeout with cooperative cancellation**: `reapOrphans` now accepts an optional `reapTimeoutMs` parameter (default 15000). When the timeout fires, the reap aborts via `AbortSignal`: in-flight workers cooperate by skipping their next mutating step (kill, truncate, unlink) so no dangerous side effects can occur after `reapOrphans` returns. The call resolves with an empty result and emits a `console.warn`. Prevents pathological cases (NFS `readdir` hang, all probes timing out simultaneously) from blocking plugin init indefinitely, and prevents lingering reap workers from wiping current-instance pid file entries that live tasks have appended after the timeout fired.
  - **Parser extraction**: the comm/lstart parsing logic is lifted out of `getPidIdentity` into a new exported `parsePsIdentity(raw)` pure function with full edge-case coverage (empty input, single-token input, leading-whitespace input, the 15/16-char `comm` boundary, and multi-whitespace separator).

  All new parameters are additive optionals; existing callers continue to work without modification. Behavior at default settings is unchanged for normal-load operation, but the new overall reap timeout introduces a conditional control-flow branch (warn + empty return) that activates only under pathological conditions where a reap exceeds the 15s default budget.

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
