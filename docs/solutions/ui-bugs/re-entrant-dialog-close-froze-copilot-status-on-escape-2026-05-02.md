---
title: "/copilot-status: re-entrant dialog close froze Esc, and the hand-rolled modal lost theming and keys"
date: 2026-05-02
last_updated: 2026-11-21
category: ui-bugs
module: tui
problem_type: ui_bug
component: tooling
symptoms:
  - "Pressing Escape in `/copilot-status` froze the entire OpenCode TUI instead of closing the modal."
  - "The freeze also affected the modal load-error path while switching to the unavailable alert."
  - "Layout and input rewrites changed the presentation but did not remove the freeze."
  - "After the Esc fix, on OpenCode 1.19.6 the modal was unstyled, ↑/↓ cycled the host chat history, nothing was selectable, and `/copilot-status` was palette-only (missing from the `/` menu)."
  - "On OpenCode 2.3.2 the command registered (`keymap.commands()` listed it) but the prompt's `/` menu answered 'No matching commands'."
root_cause: wrong_api
resolution_type: code_fix
severity: high
related_components:
  - testing_framework
tags: [tui, copilot-status, dialog-lifecycle, escape-key, modal, re-entrant-close, host-dialogs, opencode-v2]
---

# /copilot-status: re-entrant dialog close froze Esc, and the hand-rolled modal lost theming and keys

## Problem

The `/copilot-status` dialog misused the host dialog lifecycle. It passed host-owned close handling back into `api.ui.dialog.clear()`, which re-entered dialog teardown, so `Esc` froze the whole TUI. The first fix (#86, commit 98a827e) stopped the freeze. While isolating it, though, #86 also removed the modal's key handling, and that was never restored. The hand-rolled components also never set theme colors. On OpenCode 1.19.6 the result rendered but could not be used. OpenCode V2 then had its own registration trap.

## Symptoms

- Opening `/copilot-status` worked, but `Esc` froze the entire TUI (before #86).
- The RPC load-failure path had the same hazard: the modal closed itself before the unavailable alert replaced it.
- After #86, on 1.19.6:
  - text used the terminal default instead of the host theme;
  - ↑/↓ moved through the host's chat history, and no row could be selected or cancelled;
  - the command appeared only in the palette, with no `/copilot-status` slash entry.
- On 2.3.2, a `ctx.keymap.layer` in its default `base` mode registered the command, but the `/` menu said "No matching commands".

## What Didn't Work

- **Removing nested `api.ui.Dialog` wrappers.** This fixed a bad render pattern but left the close lifecycle unchanged.
- **Removing the forced `height="100%"`.** This affected layout only.
- **Removing raw `renderer.keyInput` listeners and making the modal read-only (#86).** The freeze stayed until the `onClose` re-entrance was removed. The removal also deleted `renderer.keyInput.on('keypress', handleKeyPress)` from `modal-list.tsx` and left `ConfirmCard` unmounted. Esc stopped freezing, but every other key went to the host.
- **Rewriting onto `DialogSelect` / `DialogConfirm` / `DialogAlert` during #86.** It was dropped as "degraded UX" because the re-entrant `clear()` was still in place. With the re-entrance gone, the same rewrite is the fix (#572).
- **Suspecting duplicate `@opentui/solid` / `solid-js` module identity for the unstyled modal.** This was not the cause: the host maps both to its own copies. The deleted `modal-list.tsx` and `confirm-card.tsx` set only `TextAttributes` and never `fg` or `bg`.
- **The default V2 layer mode.** `mode` defaults to `base`, which registers the command without making it visible to the slash menu.

## Solution

**1. Let the host own teardown (#86, kept).** Never call `api.ui.dialog.clear()`. Never pass `onClose` to `api.ui.dialog.replace(...)`. Async failures report upward and do not close first.

**2. V1: use the host's components (#572).** `src/tui/status-dialogs.tsx` (`createStatusDialogs`) builds list → confirm → cancel from `api.ui.DialogSelect`, `api.ui.DialogConfirm` and `api.ui.DialogAlert`, so theming, ↑/↓, Enter and Esc are the host's. The host clears `DialogConfirm` and `DialogAlert` itself right after `onConfirm` / `onCancel`, so any follow-up dialog opens on a deferred tick (`REOPEN_DELAY_MS = 50`):

```tsx
<api.ui.DialogConfirm
  title={`Cancel Copilot delegation ${task.taskId}?`}
  message="Confirm stops the running Copilot process. Cancel keeps it running."
  onConfirm={() => {
    void cancelTask(task)
  }}
  onCancel={() => {
    deferred(() => {
      openList(task.taskId)
    })
  }}
/>
```

`TuiDialogConfirmProps` is only `{ title, message, onConfirm?, onCancel? }`, so the button labels are fixed. The message text has to explain what Confirm and Cancel do. `modal-list.tsx`, `confirm-card.tsx` and their tests were deleted. The pure helpers moved to `status-format.ts`.

Registration in `src/tui/index.tsx` (`registerCopilotStatusCommand`) gained the slash name:

```tsx
{
  namespace: 'palette',
  name: 'copilot-status',
  title: 'Copilot Status',
  category: 'Copilot',
  slashName: 'copilot-status',
  desc: 'Show running Copilot delegations',
  run() {
    openList()
  },
}
```

The legacy `api.command.register` fallback keeps `slash: { name: 'copilot-status' }`.

**3. V2: use promise dialogs and a global layer (#587).** `setup` in `src/tui/index.tsx` registers through `ctx.keymap.layer` with `mode: 'global'`, which is what the host's own slash commands use:

```tsx
ctx.keymap.layer(() => ({
  mode: 'global',
  commands: [
    {
      id: 'copilot-status',
      title: 'Copilot Status',
      description: 'Show running Copilot delegations',
      group: 'Copilot',
      palette: true,
      slash: { name: 'copilot-status' },
      run() {
        flow.open()
      },
    },
  ],
}))
```

`src/tui/status-flow-v2.ts` (`createStatusFlow`) drives the flow with `ctx.ui.dialog.select / confirm / alert`. It renders no JSX, calls no `clear()`, passes no `onClose` and needs no reopen timers. Each promise settles once, and Esc settles with `undefined`:

```ts
const confirmed = await dialog.confirm({ title: `Cancel Copilot delegation ${task.taskId}?`, message: '…' })
// Esc settles with undefined; declining settles with false.
if (!isCurrent(mine) || confirmed === undefined) {
  return 'stop'
}
```

**Regression coverage:**

- `src/tui/__tests__/status-dialogs.test.ts`: "never re-enters dialog teardown: no clear() and no onClose on any path"; "cancels on confirm and reopens the refreshed list on a deferred tick".
- `src/tui/__tests__/index.test.ts`: "registers a palette command with slashName and desc via api.keymap.registerLayer".
- `src/tui/__tests__/index-v2.test.ts`: asserts `layer.mode` is `'global'`; "opens the list and closes on Esc without any plugin-initiated clear".
- `src/tui/__tests__/status-flow-v2.test.ts`: "never calls clear or show when the user presses Esc on the list" and the same for the confirm.

**Live checks:**

- **#86:** Esc closed without a freeze after an OpenCode restart.
- **#572, 1.19.6, isolated scratch project, fake `copilot`:** `/` lists the command, the modal is themed (checked on catppuccin; the light theme was not compared), ↑/↓ moves the highlight, Enter opens the confirm, Confirm cancels (SIGTERM logged), and Esc closes from both the list and the confirm.
- **#587, V2 2.3.2 and V1 1.19.6 in a PTY:** the command shows in `/`, the empty-state alert works, Esc closes it, and it reopens. The populated list and cancel on V2 are covered by unit tests only.

## Why This Works

`dialog.replace(...)` installs content into a host-owned stack. Routing the host's close back into plugin code that calls `clear()` re-entered teardown while the host was already unwinding the same dialog. With the host components, the host owns rendering, theme, keys and close. The plugin supplies data and callbacks, and it schedules follow-ups after the host's own clear, never inside it.

On V2 the promise API removes the re-entrance hazard entirely, because the host clears each dialog before the continuation runs. A slash command is only visible to the prompt's `/` menu from a `global`-mode layer.

## Prevention

- Do not hand-roll TUI modals when a host dialog exists. Home-grown components lose host theming and key routing.
- Never call `api.ui.dialog.clear()`, and never pass `onClose` to `dialog.replace` for plugin dialogs.
- Open dialogs that follow a host `DialogConfirm` / `DialogAlert` on a deferred tick.
- When a fix strips functionality to isolate a bug (key handling in #86), track the restore explicitly. Otherwise the stripped version ships as the "fixed" one.
- Register with `slashName` (V1 `registerLayer`) or `slash` plus `mode: 'global'` (V2 `keymap.layer`). Checking the registration call is not enough: confirm the command appears in the `/` menu.
- Live-check checklist for TUI dialog changes: listed in `/`, themed, ↑/↓ moves the selection, Enter acts, Esc closes from every dialog with no freeze, and the command reopens afterwards.
- When debugging TUI freezes, test lifecycle ownership before chasing layout, key-listener or module-identity theories.

## Related Issues

- PR #86 (commit 98a827e): the Esc freeze fix.
- PR #572: rebuilt on host dialogs.
- PR #587: OpenCode V2 support.
- `docs/solutions/integration-issues/two-entrypoint-rpc-tui-hardening-2026-05-01.md`
- `docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md`
