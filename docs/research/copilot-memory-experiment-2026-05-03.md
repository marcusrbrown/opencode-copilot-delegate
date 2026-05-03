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

## Cross-references

- [GitHub docs: About agentic memory for GitHub Copilot](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)
- [GitHub docs: Managing and curating Copilot Memory](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/copilot-memory)
- [`docs/research/copilot-cli-capabilities-2026-04-27.md`](./copilot-cli-capabilities-2026-04-27.md) §1 (table line 37: `memory` as `--allow-tool` kind), §11 (note that `--allow-tool=memory` is documented but not in `copilot help permissions`)
- [`AGENTS.md`](../../AGENTS.md) (project conventions; load-bearing files referenced by Memory 1–3)
