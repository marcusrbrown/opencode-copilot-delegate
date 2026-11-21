---
title: Test env restore stored the string "undefined", and wall-clock races flaked the unit suite
date: 2026-11-21
category: test-failures
module: integration_tests
problem_type: test_failure
component: testing_framework
symptoms:
  - "Restoring env with `process.env.X = original` stored the string 'undefined' when X was unset, making later suites resolve a relative `undefined/...` cache path"
  - "tools and resume suites wrote to the developer's real XDG state dir, because Bun's `os.homedir()` ignores an in-process HOME change"
  - "`tests/resume.test.ts` no-match normalization got `output.error` undefined under load"
  - "`tests/tools.test.ts` 'completion wins the race' flipped `timed_out` to true under load"
  - "`tests/subprocess.test.ts` abort test failed with 'Timed out waiting for file: …/grandchild.pid' or read an empty pid file"
root_cause: async_timing
resolution_type: test_fix
severity: medium
related_components:
  - development_workflow
tags: [flaky-tests, test-isolation, env-restore, bun, wall-clock, race-condition, fake-cli, prepublish]
---

# Test env restore stored the string "undefined", and wall-clock races flaked the unit suite

## Problem

Two defects in the test suite. Env restore leaked state between suites and onto the developer's machine. Three tests also depended on wall-clock margins and failed under load (#567). That kept `test:unit` out of `prepublishOnly` until #576.

## Symptoms

- **Env leaks.** A relative `undefined/` cache-path hazard, and real-cache and real-state writes from the test suites.
- **`resume.test.ts`** › `CLI no-match stderr normalization`: got `undefined` where `Session not found: 'no-match-name'` was expected.
- **`tools.test.ts`** › `does not mark output as timed out when completion wins the race`: `timed_out` came back true.
- **`subprocess.test.ts`** › `cancels the subprocess tree through the abort controller`: `Timed out waiting for file: …/grandchild.pid`.

## What Didn't Work

- **`process.env.X = saved` with `saved === undefined`.** Bun stores the string `"undefined"`. `defaultPortFileBaseDir` then does `process.env.XDG_CACHE_HOME ?? join(…)` and gets `"undefined"`, which is a relative path.
- **Isolating only `HOME` and `XDG_CACHE_HOME`.** Plugin init resolves the orphan PID dir through `XDG_STATE_HOME`, falling back to `os.homedir()`, and under Bun `os.homedir()` ignores the in-process `HOME`.
- **Fixed margins.** A hardcoded 500 ms `NAME_TARGET_FAILURE_WINDOW_MS` race, a fake CLI that `sleep 0.8`'d against `timeout_ms: 1200` (a 400 ms margin), a 2 s `waitForFile` budget, and a `Date.now() - startedAt < 3000` assertion. Process start-up under load eats any of these.

## Solution

**Delete-on-restore env helper (#560).** `tests/helpers/env.ts`:

```ts
export function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
```

`overrideEnv(keys, overrides)` snapshots the keys and returns a restore function that deletes the ones that were originally unset.

- `tests/tools.test.ts` and `tests/resume.test.ts` create a temp `XDG_STATE_HOME` alongside `HOME` and `XDG_CACHE_HOME`.
- #575 moved `tests/index.test.ts` onto `overrideEnv`. `src/tui/__tests__/index.test.ts` has a local `setEnv`, because `tests/` is outside the `src/` tsconfig `rootDir`.
- Regression asserts pin artifacts under the temp root, for example `expect(portFilePath.startsWith(tmpdir())).toBe(true)`.

**Make the test decide the race (#569):**

1. **Resume window.** `launchResume` and `createResumeTool` take an optional `failureWindowMs` (the default is still 500 ms). The test passes `failureWindowMs: 60_000`, so the real subprocess exit wins. The timer is now cleared once the race settles:

   ```ts
   windowTimer = setTimeout(() => resolve('timeout'), opts.failureWindowMs ?? NAME_TARGET_FAILURE_WINDOW_MS)
   ```

2. **Gate file instead of `sleep`.** The fake CLI blocks until the test writes `<bin>/release`, and only after `copilot_output` is already blocking with the 120000 ms schema cap:

   ```sh
   gate="$(dirname "$0")/release"
   while [ ! -e "$gate" ]; do sleep 0.02; done
   ```

3. **Atomic publish, unbounded poll.** The grandchild pid is written to a temp file and then `mv`'d into place, so the file exists only once it is complete. `waitForFile` polls until the file exists, and the runner's per-test timeout is the only bound. The wall-clock assertion was removed; the `cancelled` status and the grandchild being gone still prove the behavior.

**Release gate (#576).** `"prepublishOnly": "bun run typecheck && bun run test:unit && bun run build"`.

**Verification.** `test:unit` passed 10/10 consecutive runs (327 tests). The runs were unloaded, because the CPU-hog stress run was refused on a shared machine. The fixes remove the timing dependence by construction rather than by load testing.

## Why This Works

Each flake was a race between the code under test and a fixed real-time budget. Injecting the window, gating completion on a file the test writes, and publishing atomically turn "fast enough" into "happens-before", so load can slow the suite but can't change the outcome. The env bug was an assumption that assigning `undefined` unsets a variable. Deleting the key matches the original state exactly, and the `tmpdir()` asserts catch any future escape.

## Prevention

- Never restore env with `process.env.X = saved`. Use `overrideEnv` or `setEnv` from `tests/helpers/env.ts`.
- Isolate every env var the code resolves: `HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`. Don't count on `os.homedir()` following `HOME` under Bun.
- Assert that test artifacts land under `tmpdir()`.
- AGENTS.md: "Tests must be deterministic: no wall-clock timing assertions, use injected timestamps". Make production timeouts injectable and let fakes block on a gate the test controls.
- Fakes that publish files for tests should write to a temp file, then rename it.
- Don't give polls a fixed budget; let the runner's per-test timeout bound them.
- `prepublishOnly` now runs `test:unit`, so a new flake blocks publishing. Fix it, don't retry.

## Related Issues

- Issue #567; PRs #560, #569, #575 (env part), #576; issue #530 (items 1 and 3).
- `docs/solutions/best-practices/reliable-cli-integration-testing-2026-04-26.md`
