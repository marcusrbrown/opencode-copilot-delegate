---
'opencode-copilot-delegate': minor
---

Configurable orphan-reaper timeouts and parser extraction

Three medium-priority improvements to the plugin-init orphan-subprocess reaper, all from the runtime hardening backlog:

- **Configurable per-probe `ps` timeout with degradation warning**: `getPidIdentity` and the underlying `runPs` helper now accept an optional `timeoutMs` parameter (default 1000). On loaded systems where legitimate `ps` responses can exceed 1s, callers can pass a longer timeout to avoid identity-gate misses that leave orphans alive. When the timeout fires, `runPs` emits a `console.warn` so operators can detect probe degradation and tune the budget up.
- **Overall `reapOrphans` timeout**: `reapOrphans` now accepts an optional `reapTimeoutMs` parameter (default 15000). The reap body races against the timeout; on expiry, the call returns an empty result and emits a `console.warn`. Prevents pathological cases (NFS `readdir` hang, all probes timing out simultaneously) from blocking plugin init indefinitely.
- **Parser extraction**: the comm/lstart parsing logic is lifted out of `getPidIdentity` into a new exported `parsePsIdentity(raw)` pure function with full edge-case coverage (empty input, single-token input, leading-whitespace input, the 15/16-char `comm` boundary, and multi-whitespace separator).

No behavioral change at default settings. All new parameters are additive optionals; existing callers continue to work without modification.
