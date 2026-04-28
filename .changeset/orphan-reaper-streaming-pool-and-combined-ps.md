---
'opencode-copilot-delegate': minor
---

Eliminate head-of-line blocking and halve fork/exec cost in the orphan reaper

Two performance improvements to the plugin-init orphan-subprocess reaper, both surfaced in the `v0.1.x / v0.2.x runtime hardening follow-ups` tracking issue:

- **Streaming worker pool replaces chunked `Promise.all`**: under loaded conditions a single slow `ps` invocation (300-500ms is realistic) used to idle four sibling workers in the same chunk, blowing the soft init budget by 5-10x. The reaper now spawns up to `MAX_CONCURRENT_PROBES = 5` workers that drain a shared queue independently — a slow probe blocks only its own worker.
- **Combined `ps -p <pid> -o comm=,lstart=` query**: the two separate `comm` and `lstart` lookups (per entry, plus per task spawn) consolidate into a single `getPidIdentity(pid)` call. Halves fork/exec cost on the reap hot path, makes the concurrency-cap math match reality (5 workers ⇒ at most 5 concurrent `ps` subprocesses, not 10), and gets an atomic kernel snapshot of both identity legs.

Net wall-clock impact for a 10-entry orphan file with one slow `ps` probe: the chunked-of-5 worst case (~210ms) drops to roughly 200ms, but the streaming pool eliminates the artificial wave-boundary stall — the 9 fast probes complete in ~30ms instead of being trapped behind the slow one.

No public API changes. All callers and tests updated to use the combined `getPidIdentity` dependency.
