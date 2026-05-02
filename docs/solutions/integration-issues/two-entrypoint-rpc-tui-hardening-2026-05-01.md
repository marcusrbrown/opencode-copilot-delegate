---
title: Hardening Two-Entrypoint RPC/TUI Plugin Integration
date: 2026-05-01
category: integration-issues
module: copilot-status-tui-foundation
problem_type: integration_issue
component: tooling
symptoms:
  - server tools could fail to register when the TUI RPC server could not start
  - the packaged plugin could expose a broken ./tui entrypoint or omit the built TUI bundle
  - the TUI could render stale async results after cleanup or hold stale task selection during cancel flows
  - cancellation progress was not visible through RPC/TUI while a cancel was in flight
root_cause: incomplete_setup
resolution_type: code_fix
severity: high
related_components:
  - development_workflow
  - testing_framework
tags: [copilot-status, tui, rpc, two-entrypoint, packaging, cancellation, localhost-auth, port-file]
---

# Hardening Two-Entrypoint RPC/TUI Plugin Integration

## Problem

The `/copilot-status` foundation introduced a server plugin entrypoint, a TUI entrypoint, and authenticated localhost RPC between them. The first implementation had integration bugs at those seams: failures in the optional RPC/TUI layer could affect core tools, packaging could publish an unusable TUI entrypoint, and cancellation/UI state could become misleading under normal races.

## Symptoms

- Server tools could fail to register when the RPC server could not start.
- Async RPC route failures could leak as unhandled rejections or hung requests instead of structured errors.
- Unsafe session discriminators could be used as filesystem path segments for port-file storage.
- Same-session startup cleanup could delete more than stale `server-port.json` artifacts.
- `./tui` could point at raw TSX while the build emitted only server JavaScript.
- TUI RPC calls could hang indefinitely if the local server accepted a connection but never responded.
- Modal async loads could update UI after the dialog was disposed.
- Cancelling tasks disappeared immediately from the TUI list even while process teardown was still in flight.
- A stale selected task could show `Cancel failed: no such task` after it completed naturally before confirmation.

## What Didn't Work

- Treating RPC startup as mandatory during plugin initialization coupled an additive UI feature to core tool registration.
- Marking a task `cancelled` immediately on abort hid the in-flight teardown phase from the TUI and made cancellation progress look complete before the child process closed.
- Reusing the raw session discriminator as a directory name trusted host-provided input at a filesystem boundary.
- Cleaning the whole session directory during startup was broader than the actual invariant, which only needed stale port-file artifacts removed.
- Exporting `src/tui/index.tsx` without a build/export smoke test left the package contract unverified.
- Letting modal async work complete without disposal or request-token guards let late responses mutate stale UI state.

## Solution

Make each integration boundary explicit and independently recoverable.

RPC startup is best-effort. If the localhost server cannot start, log the failure and still return the existing server tools:

```ts
try {
  const rpcServer = await startRpcServer(options)
  wireRpcServerCleanup(rpcServer.close)
} catch (error) {
  logRpcStartupFailure(error)
}

return {
  tool: {
    copilot_delegate,
    copilot_output,
    copilot_cancel,
  },
}
```

RPC request handling needs a top-level async guard so route failures become structured responses. The example omits logging; production code should keep enough context for diagnosis without leaking request secrets.

```ts
const server = createServer((request, response) => {
  void handleRpcRequest(request, response).catch(() => {
    if (!response.headersSent) {
      writeJson(response, 500, { error: 'internal server error' })
      return
    }

    response.destroy()
  })
})
```

Validate session discriminators before using them as path segments:

```ts
function assertSafeSessionDiscriminator(value: string): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error('invalid session discriminator')
  }
}
```

Startup cleanup should delete only stale port-file artifacts, not the session directory:

```ts
const stalePortFiles = entries.filter(
  (entry) => entry === 'server-port.json' || entry.startsWith('server-port.json.tmp.'),
)

await Promise.all(stalePortFiles.map((entry) => rm(join(portFileDir, entry), { force: true })))
```

Cancellation uses an internal transition state. RPC/TUI can show `cancelling`, while the public `copilot_output` envelope keeps the existing `cancelled` contract:

```ts
task.abortController.signal.addEventListener('abort', () => {
  setStatus(task, 'cancelling', { pidFilePath })
  killProcessTree(task.pid).catch(() => {})
})

child.once('close', () => {
  if (task.status === 'cancelling') {
    setStatus(task, 'cancelled', { pidFilePath })
  }
})

function outputStatus(status: TaskStatus): OutputEnvelope['status'] {
  return status === 'cancelling' ? 'cancelled' : status
}
```

The TUI client adds a per-request timeout and composes it with disposal. The request signal helper owns timeout and listener cleanup after `fetch` resolves or rejects. Modal state updates check that the view is still current before mutating state:

```ts
const requestSignal = createRequestSignal(disposeSignal, requestTimeoutMs)

try {
  const response = await fetch(url, { signal: requestSignal.signal })
} finally {
  requestSignal.dispose()
}
```

```ts
const requestId = ++currentRequestId
const response = await client.tasksList()

if (disposed || requestId !== currentRequestId) return
state.value = { kind: 'ready', tasks: response.tasks }
```

The confirm card treats `no such task` during cancellation as stale selection, not a user-facing failure:

```ts
if (response.cancelled) {
  props.onConfirm()
  return
}

if (response.error === 'no such task') {
  props.onConfirm()
  return
}
```

Packaging is pinned by build/export smoke coverage. The package export points to compiled TUI JavaScript and declarations, and the build emits both server and TUI artifacts.

## Why This Works

The server plugin, TUI plugin, localhost RPC server, filesystem rendezvous, and subprocess lifecycle all fail independently. Treating them as a single synchronous path created hidden coupling: a noncritical UI startup problem could break tools, stale path input could escape the intended cache directory, async UI work could outlive its dialog, and an internal runtime transition could leak or disappear at the wrong boundary.

The fix makes the boundaries explicit:

- Core tools do not depend on RPC startup.
- RPC routes contain their own async failures.
- Filesystem path input is parsed before use.
- Cleanup targets exact artifacts.
- Internal lifecycle states support UI visibility without changing public tool envelopes.
- TUI network requests have bounded lifetime and disposal semantics.
- Package exports are verified against built artifacts.

## Prevention

- Keep additive TUI/RPC features non-fatal during server plugin initialization.
- Wrap async HTTP handlers at the server boundary, not only inside individual route branches.
- Reject unsafe path discriminators before any filesystem write.
- Delete exact stale files during startup cleanup instead of removing parent directories.
- Preserve transitional runtime states internally when UI needs progress visibility, then normalize them at public API boundaries.
- Add tests for startup fallback, structured RPC `500`s, invalid discriminators, and surgical port-file cleanup.
- Add tests for running-plus-cancelling task lists, stale cancel selection, TUI request timeout/disposal, modal late-response guards, and package build/export smoke.
- Run TUI component tests with the OpenTUI preload path (`bun run test:tui`) instead of relying on direct TSX test execution.

## Related Issues

- Plan: `docs/plans/2026-04-27-001-feat-copilot-status-tui-foundation-plan.md`
- Related runtime lifecycle learning: `docs/solutions/best-practices/centralized-terminal-state-idempotency-task-lifecycle-2026-04-28.md`
- Related process/session isolation learning: `docs/solutions/best-practices/per-instance-pid-files-spawner-liveness-gating-2026-04-28.md`
- Related local-state learning: `docs/solutions/best-practices/atomic-file-append-remove-o-excl-temp-file-2026-04-28.md`
