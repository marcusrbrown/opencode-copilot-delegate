---
title: "Isolate OpenCode live checks in a scratch rig outside the checkout"
date: 2026-11-21
category: workflow-issues
module: integration_tests
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - "Live-checking a plugin change against a real OpenCode host before merge"
  - "Comparing a worktree branch with main (A/B) in the same host version"
  - "Using a fake copilot binary so a delegation runs with no model or credentials"
  - "Running checks on a machine where the user's own OpenCode sessions are also running"
symptoms:
  - "A check launched from a worktree under .worktrees/ also loads the main checkout's opencode.json and tui.json, so two plugin copies run"
  - "A fake copilot run reported status complete with no events, because its fixture path pointed at a removed worktree"
  - "A scratch project's opencode.json was ignored because the parent profile exports OPENCODE_DISABLE_PROJECT_CONFIG=1"
root_cause: test_isolation
resolution_type: environment_setup
tags: [live-check, opencode, isolation, fake-copilot, worktrees, env-i, scratch-rig]
---

# Isolate OpenCode live checks in a scratch rig outside the checkout

## Context
Pre-merge live checks (#568, #572, #575, #578, #580, #582, #587) ran real OpenCode hosts on the developer's machine. The repo root has `opencode.json` (`"plugin": ["./src/index.ts"]`) and `tui.json` (`"plugin": ["./src/tui/index.tsx"]`), and worktrees live in `.worktrees/` inside the checkout. OpenCode finds config by walking up from the working directory. So a host started in a worktree loads that worktree's plugin *and* main's, and an A/B comparison ends up measuring both. The first #568 launcher, `run-opencode.sh`, did exactly that: it ran `cd "$WT"` into the worktree. `run-isolated.sh` replaced it.

This doc covers rig isolation only.
- Model-free load and registration checks: "Verify both hosts without a model" in `docs/solutions/integration-issues/v2-silent-zero-tools-normalize-tool-arg-schemas-2026-11-21.md`, and `tests/host-contract/run-host.sh`.
- Model-driven `opencode run` tests: `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md`.

The rig scripts quoted below live in a scratch directory outside the repo, written here as `<profile-tmp>/live-check/`. They are not committed.

## Guidance
- **Run from a scratch project outside every git checkout.** Here that is `<profile-tmp>/live-check/<check>/proj`. Give the project one `opencode.json` and one `tui.json` that each name exactly one plugin source. Alternatively, copy the built `dist/` into `proj/.opencode/plugin/<name>/` with a `package.json` that declares `"oc-plugin": ["server", "tui"]`, which is what `prepare.sh` does.
- **Drop the host environment.** Start the host under `env -i` with `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` and `TMPDIR` all inside the rig. Use a minimal `PATH` with the fake bin first, and set `OPENCODE_DISABLE_MODELS_FETCH=1` and `OPENCODE_DISABLE_AUTOUPDATE=1`.
  - If you `export` instead, also `unset OPENCODE_DISABLE_PROJECT_CONFIG OPENCODE_CONFIG_DIR OPENCODE_SESSION_ID OPENCODE_CONFIG OPENCODE_SERVER_PASSWORD`. The parent profile sets `OPENCODE_DISABLE_PROJECT_CONFIG=1`, which stops the scratch project's config from loading.
  - Known leak: in the #575 sweep check, V1 1.19.6 read `~/.opencode/opencode.json[c]` from the real home directory even though `HOME` pointed into the rig.
- **Isolate the cache whenever port files are involved.** Point `XDG_CACHE_HOME` into the rig. Touch the real `~/.cache/opencode/copilot-delegate` only to count it (`ls | wc -l`).
- **Put a fake `copilot` first on `PATH`.**
  - It should replay `tests/fixtures/happy-path.jsonl` with `FAKE_COPILOT_DELAY` seconds between lines, so tasks stay "running" long enough to navigate and cancel them.
  - Steer outcomes with keywords in the prompt: `FAIL` writes to stderr and exits 1, `SLOW` stretches the run to about 40 s.
  - Log the pid, the args and SIGTERM to a file. #572 confirmed a cancel from the fake's SIGTERM log line.
- **Make the fake fail loudly when its fixture is missing, and keep the fixture path off worktrees.** Without `set -e`, a failed `done < "$FIXTURE"` redirect skips the loop and the final `echo … finished` exits 0. That exit-0, zero-event run is what #579 turned up. This PR also hardens `tests/fixtures/bin/copilot` to fail when its fixture is missing.
- **Print what you're loading at startup.** `run-isolated.sh` prints the variant, the resolved `@opentui/core` version and `command -v copilot`. Rig scripts hardcode worktree paths, and those go stale as soon as the worktree is removed.
- **Kill only the processes you started.** Record `$!` to a pid file (`start.sh`), or trap and kill only `server_pid` (`run-host.sh`): TERM, then KILL. Never `pkill opencode`. The user's own OpenCode sessions and the Fro Bot harness run on the same machine. Afterwards, confirm with `pgrep -fl` on a path specific to the rig.

## Why This Matters
A rig that isn't isolated produces believable false results. A/B checks load two plugin copies. The user's own plugins, such as Magic Context or OMO, change host behaviour. A missing fixture looks like a successful delegation. A careless kill takes down the user's real sessions. Each of these happened, or nearly happened, during the checks listed above.

## When to Apply
- Every manual check against a real OpenCode host, V1 or V2, TUI or server.
- Any check that compares a branch worktree with main.
- Any check that writes to XDG cache or state paths: port files, PID ledgers, orphan reaping.

## Examples
The V2 TUI launcher, `<profile-tmp>/live-check/tui-v2/run-tui-v2.sh` (#587):

```sh
cd "$PROJ"
exec /usr/bin/env -i \
  HOME="$LC/home" \
  XDG_CONFIG_HOME="$LC/xdg/config" \
  XDG_DATA_HOME="$LC/xdg/data" \
  XDG_CACHE_HOME="$LC/xdg/cache" \
  XDG_STATE_HOME="$LC/xdg/state" \
  TMPDIR="$LC/tmp" \
  PATH="$FAKE_BIN:$BUN_DIR:/usr/bin:/bin:/opt/homebrew/bin" \
  OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_DISABLE_AUTOUPDATE=1 \
  "$OC2" --standalone "$@"
```

The fake's keyword switch, `<profile-tmp>/live-check/v2-model/bin/copilot`:

```bash
case "$prompt" in
  *FAIL*) sleep "${FAIL_DELAY:-4}" & wait $!; echo "fake copilot: simulated failure" >&2; exit 1 ;;
  *SLOW*) delay=1.5 ;;
  *) delay="${FAKE_COPILOT_DELAY:-0.4}" ;;
esac
```

The fixture failure is visible in the fake's log from the #578 check: the run "finished" in the same second it started, even though the default delay is 3 s per line.

```text
2026-11-21T02:13:38Z pid=43996 args=-p unit2 check --output-format json -s --allow-all-tools --no-ask-user
2026-11-21T02:13:38Z pid=43996 finished
```

Kill only your own server, from `cleanup` in `tests/host-contract/run-host.sh`:

```bash
if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
  for sig in TERM KILL; do
    kill "-$sig" "$server_pid" 2>/dev/null || break
```

## Related
- `docs/solutions/integration-issues/v2-silent-zero-tools-normalize-tool-arg-schemas-2026-11-21.md`, "Verify both hosts without a model"
- `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md`
- `tests/host-contract/run-host.sh` and `tests/fixtures/bin/copilot` (the CI form of this rig, #584)
- Issue #579 and PR #583 (an exit-0, zero-output run is now reported as `failed`)
