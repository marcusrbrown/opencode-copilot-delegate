---
title: Copilot CLI memory experiment — `store_memory` tool surface
type: research
date: 2026-05-03
related:
  - docs/research/copilot-cli-capabilities-2026-04-27.md
status: empirical
---

# Copilot CLI memory experiment — `store_memory` tool surface

Empirical investigation of GitHub Copilot's [agentic memory feature](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) as exposed through Copilot CLI 1.0.40 in `-p` non-interactive mode. Carried out 2026-05-03 against the live `marcusrbrown/opencode-copilot-delegate` repository via `copilot_delegate` (claude-sonnet-4.6).

## Executive summary

| Question | Answer |
|---|---|
| Is there a callable `memory` tool in `copilot -p` mode? | **Yes — `store_memory`.** First-class tool, available by default without `--allow-tool=memory`. |
| Does it require structured citations? | Yes (freeform string), and a `reason` ≥ 2–3 sentences. |
| Is `fact` length-limited? | **Yes — < 200 characters.** The binding constraint for memory authoring. |
| Does it return a memory ID? | No. Returns the literal string `"Memory stored successfully."` |
| Is there a `list_memories` / `get_memories` tool? | **No.** Verification requires the GitHub web UI. |
| Is `--allow-tool=memory` required? | No. The flag is documented but not enforced as a gate in 1.0.40. |
| Are memories the same surface as `~/.copilot/session-state/`? | No. Memories are repository-scoped server-side state, not local session-state files. |

The `memory` kind in [`docs/research/copilot-cli-capabilities-2026-04-27.md`](./copilot-cli-capabilities-2026-04-27.md) §1, §11 turns out to refer to a real callable tool, not just a permission category. The discrepancy with `copilot help permissions` (which omits `memory`) reflects an under-documented surface, not an absent one.

## `store_memory` tool API (empirically observed)

```text
store_memory({
  subject:   string,  // 1–2 words; topic label
  fact:      string,  // < 200 characters; the essential claim
  citations: string,  // freeform; file paths + line ranges
  reason:    string,  // ≥ 2–3 sentences explaining why this is worth storing
})
→ "Memory stored successfully."
```

**Properties verified live:**

- All four fields appear required by convention (no field was omitted in successful calls; behavior on omission untested).
- `citations` is a single string, not an array of `{ file, line }` objects. The system uses these for [citation-backed validation](https://docs.github.com/en/copilot/concepts/agents/copilot-memory#how-memories-are-stored-retained-and-used) — memories are revalidated against the current codebase before reuse.
- The 200-character `fact` limit forces compound claims to be split across multiple `store_memory` calls. The full elaboration belongs in `reason`.
- No memory ID is returned. There is no documented way to delete or update a specific memory from a CLI run; curation lives in the GitHub web UI.

**Where memories live (per upstream docs):**

- Server-side, scoped to the repository (not the user, not the session).
- Auto-deleted after 28 days unless re-derived from current code.
- Used by Copilot cloud agent, Copilot code review, and Copilot CLI (when Copilot Memory is enabled for the user).
- Manageable at: `https://github.com/<owner>/<repo>/settings` → Copilot → Memory.

## Memories stored in this experiment

Three high-impact architectural facts were verified against the codebase and persisted via three `store_memory` calls. All three returned `"Memory stored successfully."`.

### Memory 1 — DUAL pattern for OpenCode plugins listed in multiple config sources

```text
subject:   DUAL pattern
fact:      Plugin factory invoked once per config source. Two fixes
           required: normalizeToolArgSchemas patches Zod cross-instance
           serialization; plugInOnce prevents duplicate registration via
           globalThis singleton.
citations: src/lib/normalize-tool-arg-schemas.ts:43-62,
           src/runtime/plugin-singleton.ts:35-37,
           src/index.ts:124-134, src/index.ts:138-155
reason:    OpenCode invokes the plugin factory once per config source
           that lists it. When BOTH user-level and project-level
           opencode.json reference this plugin, the factory runs twice
           in the same process. Two independent fixes are required for
           correctness: schema metadata preservation across Zod
           instances, and idempotent registration via a globalThis
           singleton. Either alone is insufficient.
```

### Memory 2 — Centralized terminal-state transitions via `setStatus`

```text
subject:   task lifecycle
fact:      All terminal TaskState transitions (complete, failed,
           cancelled) route through setStatus in task-status.ts
           (idempotent on existing terminals). Three call sites in
           subprocess.ts: finalizeTask, abort listener, error handler.
citations: src/runtime/task-status.ts:35-56,
           src/runtime/subprocess.ts:69,153,163,170
reason:    setStatus is the single terminal-write entry point and is
           idempotent on existing terminal states (preserves the
           first-arrival terminal status). Direct mutation of
           task.status anywhere else is a bug. The contract prevents
           races between abort, exit, and error paths from corrupting
           the recorded outcome.
```

**Verification note:** The delegate report flagged a count drift — there are now **4** `setStatus` call sites in `subprocess.ts` (the close handler contributes two: one for the cancellation path at line 170, one via `finalizeTask` at line 175 → 69). The "three categories" framing (close / abort / error) is still accurate, but the literal call count is 4. The fact was stored as written; if Copilot revalidates citations and finds a mismatch, the memory may be marked stale.

### Memory 3 — Orphan reaper safety: per-instance PID files + spawner-liveness + identity gates

```text
subject:   orphan reaper
fact:      Per-instance PID files: <XDG_STATE_HOME>/opencode-copilot-
           delegate/orphans/<pid>.pids. Two reap gates: spawner-liveness
           (process.kill probe) and identity (ps comm+lstart match)
           before any kill.
citations: src/runtime/pid-file.ts:76-85,
           src/runtime/orphan-reaper.ts:48-55,171-178,377,219-231
reason:    Each plugin instance writes its in-flight task PIDs to a
           per-process file (not shared). Cross-instance reaping requires
           two independent safety gates: spawner-liveness (skip a foreign
           PID file if its owning plugin is alive) and strict identity
           (ps comm+lstart exact-match before any kill). Both gates are
           required because either alone admits PID-reuse kills.
```

## Verification — confirmed 2026-05-03

Persistence verified via the GitHub web UI at `https://github.com/marcusrbrown/opencode-copilot-delegate/settings` → **Copilot** → **Memory** (page label: "Copilot memory"; feature in **Preview**). All three memories landed and are listed with the subjects, fact text, and citations exactly as stored — no paraphrasing or condensation by the memory layer. Each entry carries two tags below the fact text:

- `github/cli` — provenance tag indicating the memory was authored by a Copilot CLI session (vs. cloud agent or code review)
- `claude-sonnet-4.6` — model identifier of the writing session

The Memory page rendered:

| Subject | Stored exactly as in §3 above |
|---|---|
| `orphan reaper` | ✅ |
| `DUAL pattern` | ✅ |
| `task lifecycle` | ✅ |

This closes the experimental loop: `"Memory stored successfully."` from `store_memory` corresponds to actual server-side persistence visible in the repo's Copilot Memory page. The success string is therefore a trustworthy persistence signal in 1.0.40, not just a syntactic acknowledgement.

The CLI provides no readback path for stored memories from a `-p` run. Verification continues to require the GitHub web UI; build a manual confirmation step into any future memory-seeding workflow.

## Recommendations for future `copilot_delegate` runs

1. **Treat `store_memory` as a real tool surface.** It works without `--allow-tool=memory`. No spawn-time flag changes needed in `src/tools/delegate.ts`.

2. **Memory authoring is the parent agent's responsibility.** A delegated `-p` run will not spontaneously store useful memories; the parent prompt must explicitly direct it to verify-then-store. Pattern that worked in this experiment:
   - Step 1: discover what tools are callable
   - Step 2: verify each fact against the codebase, citing files and line ranges
   - Step 3: call `store_memory` per fact with a tight subject + < 200-char fact + freeform citations + 2–3 sentence reason
   - Step 4: report what was stored and surface verification path to the human

3. **Split compound claims.** The 200-character `fact` limit means architectural decisions like the DUAL pattern fit only as a high-level summary; details live in `reason`. For multi-part invariants, consider splitting into separate calls with related subjects (e.g., `DUAL pattern: schemas` + `DUAL pattern: singleton`).

4. **Validate before storing.** The system rechecks citations on use; memories pointing at code that no longer exists are skipped. Storing an unverified or drifted fact wastes the auto-deletion budget. Always include line ranges along with file paths.

5. **Include a memory-seeding step in any `copilot_delegate` task that touches load-bearing invariants.** Specifically: any change to `src/lib/normalize-tool-arg-schemas.ts`, `src/runtime/plugin-singleton.ts`, `src/runtime/task-status.ts`, `src/runtime/subprocess.ts`, `src/runtime/pid-file.ts`, or `src/runtime/orphan-reaper.ts` should refresh the corresponding memory while the delegated session is still in those files.

6. **Verification requires the GitHub web UI.** Build a manual confirmation step into any memory-seeding workflow. There is no in-runtime list/inspect tool.

7. **Watch the 28-day expiration.** Memories auto-delete after 28 days unless re-derived from the same code. Long-lived architectural memories therefore need periodic refresh — either via a scheduled `copilot_delegate` task or via natural code traffic that re-encounters the same files.

## Open questions and follow-ups

- **Behavior on omitted fields.** Untested: does `store_memory` fail validation if any of `subject`/`fact`/`citations`/`reason` is missing or empty?
- **Behavior on duplicate facts.** Untested: storing the same fact twice — deduplicated, both kept, error?
- **Memory layer error surface.** None observed in this run. If the user lacks Copilot Memory permission or hits a quota, the failure mode (silent drop, error string, exception) is unknown.
- **Effect of `--no-custom-instructions` on memory use.** When Copilot loads `AGENTS.md` and `copilot-instructions.md`, do stored memories layer on top of those instructions or compete with them? Untested in this experiment.
- **Citation format strictness.** The freeform `citations` field accepted comma-separated `path:line-range` entries. Whether Copilot's validation parses ranges, single lines, or whole-file references with equal fidelity is unknown.

## 2026-05-04 follow-up — stale-citation behavior and memory-reuse signal

> **Cleanup required:** This validation run created 3 intentional-pollution entries in the repo's Memory page with subjects `memtest-stale-file`, `memtest-bad-range`, and `memtest-mismatch`. They will auto-expire in 28 days. For earlier removal, delete them manually at `https://github.com/marcusrbrown/opencode-copilot-delegate/settings` → Copilot → Memory. Each polluted entry costs context budget in every future Copilot session on this repo until removed.

A second `copilot_delegate` (claude-sonnet-4.6, 71.7s, 1 premium request, 892 events) was run to resolve two questions left open after the original experiment.

### Q1 — Stale-citation behavior

Three `store_memory` calls were made with intentionally-broken citations:

| # | Subject | Citation defect | Response |
|---|---|---|---|
| 1 | `memtest-stale-file` | File does not exist (`src/runtime/totally-nonexistent-fake-file.ts:1-10`) | `"Memory stored successfully."` |
| 2 | `memtest-bad-range` | Real file, lines past EOF (`src/index.ts:99999-100000`) | `"Memory stored successfully."` |
| 3 | `memtest-mismatch` | Real file/lines, fact is fabricated (claim about `processOrders` against the import block at `src/index.ts:1-5`) | `"Memory stored successfully."` |

**Verdict:** `store_memory` performs **zero write-time validation**. File existence, line range validity, and content/citation alignment are all unverified. The API is a pure write-through that accepts anything well-formed.

Upstream docs claim that memories with stale citations are "silently dropped" on read; this experiment did not measure read-side behavior, but the write path is no defense against garbage-in.

**Implication for the memory-seeding directive (`.github/copilot-instructions.md` from PR #97):** the directive must explicitly require agents to verify citations before calling `store_memory`. The platform won't catch errors, and polluted memories consume context budget on every subsequent session.

### Q2 — Memory reuse signal

The same delegation asked itself: *"What are the two reaping safety gates in the orphan reaper, and where in source are they implemented?"* The accurate answer is recorded in the `orphan reaper` memory from §"Memory 3" above.

**Result:** The model produced an answer with citations matching the stored memory **exactly** — `src/runtime/orphan-reaper.ts:48-55`, `:377`, `:171-178`, `:219-231` — without making any tool call related to memory retrieval.

**Mechanism (per the model's own observation):** memories arrive as a `<memories>` block injected into the session's system prompt at startup. Recall happens via natural attention over prompt context, not via on-demand tool invocation. No `get_memories` / `recall_memory` / `list_memories` tool exists in the CLI tool inventory.

**Verdict:** Memory recall is **invisible** to the parent session reading JSONL output.

**Implications:**

- **Token cost is fixed.** Each stored memory consumes prompt tokens at every session startup regardless of whether the model actually attends to it.
- **Pollution is durable.** A bad memory will appear in every future session's system prompt and consume context budget until 28-day expiry or manual UI deletion. Garbage scales with experiment frequency.
- **Audit is impossible.** A parent agent reading JSONL cannot distinguish a memory-influenced answer from a pure model answer. Workflows that depend on detecting memory use cannot be built.
- **Recall is best-effort, not contractual.** Even when a memory is in-prompt, the model may ignore it or compose around it — there's no enforcement.

### No deletion API

No `delete_memory`, `update_memory`, or `list_memories` tool is exposed in the CLI tool inventory. Only `store_memory` exists on the curation surface. An agent that pollutes the memory namespace has no in-process remediation path. Curation lives entirely in the GitHub web UI.

### Resolved open questions

From the original §"Open questions and follow-ups":

- ~~Memory layer error surface~~ — none observed across 6+ calls (3 valid in PR #95, 3 intentionally invalid here). Error surface, if any, fires only on auth/quota issues outside this experiment's scope.
- ~~Citation format strictness~~ — empirically permissive: accepted comma-separated `path:line-range` entries with no parsing or validation.

Still untested:

- Behavior on truly-missing required fields (the experiment supplied present-but-invalid values).
- Behavior on storing the exact same fact twice (deduplication, both kept, or error).
- `--no-custom-instructions` interaction with stored memories.

### Additional recommendations (extends §"Recommendations for future `copilot_delegate` runs")

8. **Verify citations before storing.** The system rechecks citations on use, but the write path does not. Always confirm file existence and line range coverage before calling `store_memory`. A simple `read` of the cited range with a content-match check is sufficient.

9. **Treat memory recall as invisible.** Don't design workflows that depend on detecting "memory was used" — there's no signal. Build on the assumption that memory ENRICHES context at session startup but does not TRIGGER actions.

10. **Avoid memory pollution on production repos.** Every stored memory costs context budget on every future session for up to 28 days. Don't run write-side experiments on a real repo — use a sandbox. The 3 `memtest-*` entries from this run are a warning example.

11. **Pair every `store_memory` call with verification logic in the same delegated session.** Pattern:
    1. Read the cited file and lines via `read`.
    2. Confirm the fact is grounded in that exact range (e.g., a substring check or an LLM cross-check).
    3. Only then call `store_memory`.
    4. Report verification outcome alongside the success string.

## 2026-05-04 follow-up part 2 — duplicate handling, subject collision, `--no-custom-instructions` effect

A third `copilot_delegate` (claude-sonnet-4.6, 6m 8s, 1 premium request, 1440 events) ran three additional tests to resolve the remaining open questions about `store_memory` behavior and the memory-loading pipeline. **The most consequential finding is Test E:** memories share the custom-instructions loading bus.

### Test C — Duplicate write handling

Called `store_memory` with arguments byte-for-byte identical to the existing `orphan reaper` memory.

**Result:** `"Memory stored successfully."` returned with no dedup signal, no rejection, no warning.

**Verdict:** From the caller's perspective, `store_memory` performs no write-time duplicate detection. Whether the backend deduplicates, appends, or replaces is unobservable at write time and only resolves when a subsequent session inspects its `<memories>` block.

### Test D — Subject collision

Called `store_memory` with subject `memtest-stale-file` (matching an existing pollution entry) but a clearly different fact (`"Subject collision test marker — different fact, same subject..."`).

**Result:** `"Memory stored successfully."` — same string, no collision warning.

**Verdict:** Subject is not enforced as a uniqueness or lookup key at write time. The API is purely append-oriented from the caller's view: any `(subject, fact, citations, reason)` tuple is accepted regardless of subject reuse. The backend's actual storage model (key-value with subject as key, vs. independent records) remains unobservable at write.

### Test E — `--no-custom-instructions` effect on memory loading

Two parallel `copilot -p` calls asked the same question, both with `--deny-tool=read --deny-tool=shell` to block source inspection. The accurate answer requires recalling the `orphan reaper` memory's exact line ranges (`:48-55`, `:171-178`, `:377`, `:219-231`).

| Mode | Custom instructions | Wall-clock | `:48-55`? | `:171-178`? | `:377`? | `:219-231`? | Notable |
|---|---|---|---|---|---|---|---|
| **E1** baseline | ON (default) | ~26s | ✅ | ✅ | ✅ | ✅ | Model explicitly stated *"falling back to the verified repo memory"* |
| **E2** stripped | OFF (`--no-custom-instructions`) | 115s | ❌ (`45-52`) | ❌ (`169-175`) | ⚠ (`375-377`) | ❌ (`216-228`) | Model escalated to GitHub MCP `get_file_contents` to fetch source; produced independently-derived ranges |

**Verdict:** Memories load as part of the custom-instructions injection path, not as an independent always-on system. `--no-custom-instructions` strips memories alongside `AGENTS.md` and `copilot-instructions.md`. E2's 4.4× slowdown plus citation divergence — combined with the absence of a `<memories>` block in its system prompt — confirm the loading bus is shared.

**Architectural implication:** Any agent or workflow that runs Copilot CLI with `--no-custom-instructions` will see no stored memories regardless of repo settings. This is the operational signature of the loading-path coupling, and it constrains how memory-bearing delegations can be parameterized.

### Updated open-questions list

The original "Still untested" list resolves further:

- ~~Behavior on storing the exact same fact twice~~ — resolved (Test C): no observable dedup signal at write time.
- ~~`--no-custom-instructions` interaction with stored memories~~ — resolved (Test E): memories share the custom-instructions loading bus.

Newly resolved:

- Subject is not enforced as a uniqueness key at write time (Test D).

Still untested:

- Behavior on truly-missing required fields (every test so far supplied present-but-invalid values).
- Whether the backend dedups identical writes (Test C only proves the write-time signal is invariant, not the backend behavior).
- Whether subject collision results in old replaced, new appended, or both retained (Test D's outcome is unobservable until a future session reads its `<memories>` block).

### Additional recommendations (extends list above)

12. **`--no-custom-instructions` strips memories.** When delegating to a Copilot CLI subprocess, omit this flag if you want stored architectural memories to be part of the child's context. Use it deliberately when you need a "clean slate" baseline for comparison, but understand that the child will not benefit from the repo's memory layer.

13. **Subject reuse is permitted but unmodelled at write.** Don't treat subject as a stable key. If you want to refresh a memory, expect that a previous entry with the same subject may persist alongside the new one — verify in the GitHub UI.

### Updated pollution status (cumulative across both follow-up runs)

| Subject | Source | Status |
|---|---|---|
| `memtest-stale-file` | Q1 (Test A1) | Pollution — delete from UI |
| `memtest-bad-range` | Q1 (Test A2) | Pollution — delete from UI |
| `memtest-mismatch` | Q1 (Test A3) | Pollution — delete from UI |
| `memtest-stale-file` (collision) | Test D | Either replaced original or coexists with it — delete on inspection |
| `orphan reaper` (duplicate) | Test C | Either dedup'd by backend or coexists with original real memory — keep one canonical entry |

**Manual cleanup actions for the repo Memory page** (`https://github.com/marcusrbrown/opencode-copilot-delegate/settings` → Copilot → Memory):

- Delete every `memtest-*` entry visible (3 unique subjects, possibly 4 entries if the Test D collision created a duplicate).
- Inspect `orphan reaper` — keep ONE entry. If the backend retained both Test C's duplicate write, delete the redundant copy.
- Retain the three real architectural memories: `orphan reaper` (one canonical copy), `task lifecycle`, `DUAL pattern`.

## Cross-references

- [GitHub docs: About agentic memory for GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- [GitHub docs: Managing and curating Copilot Memory](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory)
- [`docs/research/copilot-cli-capabilities-2026-04-27.md`](./copilot-cli-capabilities-2026-04-27.md) §1 (table line 37: `memory` as `--allow-tool` kind), §11 (note that `--allow-tool=memory` is documented but not in `copilot help permissions`)
- [`AGENTS.md`](../../AGENTS.md) (project conventions; load-bearing files referenced by Memory 1–3)
- [`.github/copilot-instructions.md`](../../.github/copilot-instructions.md) §"Persisting Architectural Memory" — the seeding directive that this follow-up's Q1 finding strengthens (verify-before-storing).
