---
'opencode-copilot-delegate': minor
---

Add `timedOut: boolean` to `ReapResult` so consumers can distinguish a successful no-op reap (nothing to do) from a timeout-aborted reap (gave up; orphans may remain). The flag is `false` on every success path and `true` only when the overall `reapOrphans` timeout fires.

When `timedOut` is `true`, the count fields are zero placeholders, not partial-progress accounting — in-flight workers may have already invoked `killProcessTree` or scanned files before the abort signal landed, but those side effects are not reflected in the returned counts. Treat a timed-out result as "no reliable count signal" and warn or retry.

Note for TypeScript consumers: `ReapResult` is exported from the package's runtime types and gains a required field. Any caller constructing a `ReapResult` literal will need to add `timedOut` explicitly. Internal callers in this repo are already updated.
