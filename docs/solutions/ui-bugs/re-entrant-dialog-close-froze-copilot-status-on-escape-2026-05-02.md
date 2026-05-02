---
title: Re-entrant dialog close froze /copilot-status on Escape
date: 2026-05-02
category: ui-bugs
module: tui
problem_type: ui_bug
component: tooling
symptoms:
  - Pressing Escape in `/copilot-status` froze the entire OpenCode TUI instead of closing the modal.
  - The freeze also affected the modal load-error path while switching to the unavailable alert.
  - Layout and input rewrites changed the presentation but did not remove the freeze.
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [tui, copilot-status, dialog-lifecycle, escape-key, modal, re-entrant-close]
---

# Re-entrant dialog close froze /copilot-status on Escape

## Problem

The custom `/copilot-status` dialog path in the TUI plugin misused the host dialog lifecycle. Pressing `Esc` could freeze the whole OpenCode TUI because the plugin fed host-owned close handling back into `api.ui.dialog.clear()` and re-entered dialog teardown.

## Symptoms

- Opening `/copilot-status` worked, but pressing `Esc` froze the entire TUI instead of closing the modal.
- The same close-flow hazard existed on RPC load failure, where the modal could try to close itself before the unavailable alert replaced it.
- The bug survived several UI-level changes, which made layout and keyboard handling look like the cause even though the lifecycle bug remained.

## What Didn't Work

- Removing nested `api.ui.Dialog` wrappers. That fixed a bad render pattern but left the close lifecycle unchanged.
- Removing forced `height="100%"`. That affected layout only.
- Removing raw `renderer.keyInput` listeners from the live path. The freeze still happened when the host handled `Esc`.
- Rewriting the live path onto `DialogSelect`, `DialogConfirm`, and `DialogAlert`. That degraded the UX and still failed to isolate the real bug.
- Making the custom modal read-only. That removed extra interaction code, but the close path was still re-entrant.

## Solution

Let the host own dialog teardown for the custom status modal, and treat modal load failures as error reporting rather than self-closing.

In `src/tui/index.tsx`, keep `closeDialog` for explicit confirm and alert actions, but do not pass it back into the host `dialog.replace(..., onClose)` path for the custom status dialog:

```tsx
const closeDialog = () => {
  api.ui.dialog.clear()
}

const openList = (initialTaskId?: string) => {
  api.ui.dialog.setSize('large')
  api.ui.dialog.replace(() => {
    return (
      <ModalList
        onClose={closeDialog}
        onLoadError={showUnavailableAlert}
        initialTaskId={initialTaskId}
        rpc={rpc}
      />
    )
  })
}
```

In `src/tui/components/modal-list.tsx`, report load failure without closing first:

```tsx
void loadTasks().catch((error) => {
  if (disposed) {
    return
  }

  props.onLoadError?.(error)
})
```

Regression coverage pins the lifecycle contract:

- `src/tui/__tests__/index.test.ts` asserts the custom status dialog replacement does not receive a re-entrant host `onClose` callback.
- `src/tui/__tests__/modal-list.test.tsx` asserts load failures report `error` without a preceding `close`.

Verification for the fix:

- focused RED/GREEN tests for the close-flow bug
- `bun run test:tui`
- `bun run lint`
- `bun run typecheck`
- `bun run build`
- live OpenCode restart, then `Esc` closed the modal cleanly instead of freezing the TUI

## Why This Works

`api.ui.dialog.replace(...)` installs content into a host-owned dialog stack. The broken path told the host to call back into plugin code during close so the plugin could call `api.ui.dialog.clear()` again. Pressing `Esc` therefore re-entered dialog teardown while the host was already unwinding that same dialog.

The RPC load-error path had the same structural bug from the other direction: it mixed "close the current dialog" and "replace the current dialog with an unavailable alert" in the same failure path.

The fix restores clean ownership boundaries:

- the host closes the custom modal
- the modal reports failures upward instead of mutating dialog state first
- the parent decides whether to replace the dialog with an alert without a pre-emptive `clear()` re-entering the host close flow

## Prevention

- Do not pass `api.ui.dialog.clear()` back into `api.ui.dialog.replace(..., onClose)` for custom dialogs.
- In async failure paths, do not clear the current dialog before surfacing the replacement error state.
- Keep regression coverage that proves the custom status dialog does not re-enter the host close callback path.
- Keep regression coverage that proves load errors are reported before any close-side effects.
- When debugging TUI freezes, test lifecycle ownership before chasing layout or key-listener theories.
- Preserve host-integrated verification for TUI fixes: `bun run test:tui`, `bun run lint`, `bun run typecheck`, `bun run build`, then restart OpenCode and exercise the live modal.

## Related Issues

- Related prior hardening in the same area: `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md`
- No direct GitHub issue matched this specific Esc-freeze path during documentation research.
