---
title: "OpenCode V2 TUI finds the server's RPC port file by the server pid"
date: 2026-11-21
category: best-practices
module: copilot-status-tui-foundation
problem_type: architecture_pattern
component: api
severity: high
applies_when:
  - "A TUI plugin on OpenCode V2 must reach state owned by the server process"
  - "A per-process file is keyed by an env var or pid that only one of the two processes can see"
  - "Deciding whether a TUI plugin should ship solid-js or @opentui/* as dependencies"
symptoms:
  - "Under V1's OPENCODE_SESSION_ID ?? pid key, the V2 TUI would look under its own pid and never find the server's server-port.json"
  - "A TUI attached to a remote server (--server <url>) could read an unrelated local port file whose directory happens to match the remote pid"
root_cause: wrong_api
resolution_type: code_fix
related_components:
  - frontend
  - dependencies
tags: [opencode-v2, dual-host, rpc, port-file, discriminator, server-info, tui, optional-peers]
---

# OpenCode V2 TUI finds the server's RPC port file by the server pid

## Context
The plugin's RPC server publishes `<XDG_CACHE_HOME>/opencode/copilot-delegate/<discriminator>/server-port.json`. On V1, the TUI and the server share a process, so `defaultSessionDiscriminator()` in `src/runtime/rpc-paths.ts` (`OPENCODE_SESSION_ID ?? String(process.pid)`) gives the same key on both sides. On V2 the TUI is a separate process from the server, and `OPENCODE_SESSION_ID` is unset in both (#582 live check). Each side would fall back to its own pid, so the keys could never match. `ctx.location` and `ctx.options` carry nothing that identifies the server process.

## Guidance
- **Key the port file by something the server owns and the client can ask the server for.** On V2, `setupV2` in `src/hosts/v2.ts` passes `rpcSessionDiscriminator: serverPidDiscriminator(process.pid)` to `initializeProcess` in `src/core/process.ts`. That ignores `OPENCODE_SESSION_ID`, so a decoy value in the server's environment can't move the file.
- **Have the client read that identity from the live connection on every request.** The V2 `setup` in `src/tui/index.tsx` builds `createRpcClient({ resolveSessionDiscriminator })`, which calls `ctx.client.server.info()` each time. `resolvePortFilePath` in `src/tui/rpc-client.ts` resolves it per request, so the client follows a managed service that restarts with a new pid.
- **Treat the server's reply as untrusted path input, and check it on both sides.** `serverPidDiscriminator` returns `undefined` for anything that is not a positive safe integer. `assertSafeSessionDiscriminator` in `src/runtime/rpc-paths.ts` rejects empty values, `.`, `..`, `/` and `\`. `startRpcServer` calls it before writing and `resolvePortFilePath` calls it before reading.
- **Guard against a remote server.** The port file is local, so a remote server's pid could collide with an unrelated local directory. `discriminatorForServer` compares `info.hostname` with `os.hostname()`, ignoring case, and throws when they differ. It treats a missing hostname as local. `urls` doesn't help here: it is the server's own view and reads as loopback even when the server is remote.
- **Leave V1 alone.** The V1 `tui` entry still calls `createRpcClient()` with the default discriminator.
- **Rejected designs:**
  - Keying by the location directory: one server process and one RPC server serve every location.
  - Keying by the server URL's port: the server would have to publish it.
  - Using V2's `ctx.rpc`: it would mean rewriting the RPC layer for no gain.
- **Don't ship UI runtimes the host already provides.** Both hosts resolve externalized `solid-js`, `@opentui/core` and `@opentui/solid` to their own copies (section 7 of `docs/research/opencode-v2-host-contract-2026-11.md`), so a shipped copy and its native binary are never loaded. #587 moved them to `devDependencies` plus optional `peerDependencies` (`>=0.4.5`, `>=0.4.5`, `>=1.9.10`). The dev pin is `@opentui` 0.8.4, the lowest version that satisfies both hosts' peers: `@opencode/plugin@2.3.2` needs `>=0.8.4` and `@opencode-ai/plugin@1.19.6` needs `>=0.4.5`. PR #589 adds a Renovate hold that keeps `@opentui/*` at 0.8.4.

## Why This Matters
With the V1 key, `/copilot-status` on V2 would always answer "Status unavailable." and the cause would be invisible. With a pid but no hostname check, a TUI attached to a remote server could authenticate against whatever local process owns a same-numbered directory. Reading the identity per request, rather than once at startup, avoids a stale-pid failure after a service restart.

## When to Apply
- Any time two host processes have to rendezvous through a file or socket: derive the key from an identity the client can ask the owning process for. Don't rely on an environment variable that only one side inherits.
- Any time a value from the network becomes a path segment.
- Any time you're deciding whether to depend on a package the host provides to plugins: check which copy the host actually loads first.

## Examples
Server side, `setupV2` in `src/hosts/v2.ts`:

```ts
const resources = await acquireProcessCore(() =>
  initializeProcess({
    log: stderrLog,
    rpcSessionDiscriminator: serverPidDiscriminator(process.pid),
  }),
)
```

TUI side, `setup` in `src/tui/index.tsx`:

```ts
const rpc = createRpcClient({
  resolveSessionDiscriminator: async () => {
    return discriminatorForServer(await ctx.client.server.info())
  },
})
```

The remote guard, `discriminatorForServer` in `src/runtime/rpc-paths.ts`:

```ts
if (
  typeof info.hostname === 'string' &&
  info.hostname.toLowerCase() !== localHostname.toLowerCase()
) {
  throw new Error(
    `status is only available for a local server (this server runs on ${info.hostname})`,
  )
}
```

Tests that pin the behaviour:
- `tests/host-v2.test.ts`: "publishes the RPC port file under the server pid, ignoring OPENCODE_SESSION_ID"
- `src/tui/__tests__/index-v2.test.ts`: "resolves the server pid on every open, so a restarted service is followed", "does not read a local port file when the server runs on another machine", "rejects a server pid that is not a positive integer"
- `src/tui/__tests__/rpc-client.test.ts`: "resolves the discriminator on every request", "refuses an unsafe fixed discriminator too"

## Related
- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md` (the port-file contract this extends)
- `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md`
- `docs/research/opencode-v2-host-contract-2026-11.md`, section 7 (module identity)
- PR #587, including its review-fix commit "client-side discriminator check, remote-server guard"
- PR #589, which adds a Renovate hold on `@opentui/*` at 0.8.4
