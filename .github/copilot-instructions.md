# Copilot Instructions

This is an [OpenCode](https://opencode.ai) plugin written in TypeScript. It delegates tasks to GitHub Copilot CLI (`copilot -p`) as background subprocesses and reports results back through OpenCode's tool system.

## Project Conventions

Follow AGENTS.md for architecture, coding standards, and module boundaries.

## Critical Rules

- **No type suppression**: never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- **No implicit any**: all function parameters and return types must be inferrable or annotated
- **Discriminated unions over optional properties**: prefer `{ type: 'success', data } | { type: 'error', message }` over `{ data?: T, error?: string }`
- **Parse, don't validate**: use Zod schemas for external input; trust internal types
- **Structured errors**: tools return `{ error: string }` objects, never throw

## Stack

- **Runtime**: Bun
- **Language**: TypeScript (strict mode)
- **Linting/formatting**: Biome (not ESLint/Prettier)
- **Test framework**: `bun:test`
- **Build**: `bun build` + `tsc --emitDeclarationOnly`
- **Dependencies**: `fkill` for process cleanup; `@opencode-ai/plugin` and `@opencode-ai/sdk` as peer dependencies

## Verification Commands

Run all four before considering work complete:

```bash
bun test          # Unit + integration tests
bun run typecheck # tsc --noEmit (strict)
bun run lint      # biome check .
bun run build     # Bundle + declaration emit
```

## Module Boundaries

| Module | Owns | Must Not |
|--------|------|----------|
| `src/tools/` | Tool definitions, schema, execute functions | Import from other tools |
| `src/runtime/` | Subprocess management, task registry, JSONL parsing, notifications | Reference OpenCode plugin/tool APIs directly |
| `src/discovery/` | Agent file discovery, description builder | Depend on runtime or tools |
| `src/index.ts` | Plugin entrypoint, wiring | Contain business logic |

## Persisting Architectural Memory

This repo has [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) enabled (Preview). When you modify load-bearing invariants, call `store_memory` to refresh the corresponding entry so future Copilot sessions inherit the current architecture rather than rediscover it. Memories auto-expire after 28 days unless re-derived from current code.

Trigger files (non-exhaustive):

- `src/lib/normalize-tool-arg-schemas.ts` and `src/runtime/plugin-singleton.ts` — the DUAL pattern (cross-instance Zod metadata + duplicate factory invocation)
- `src/runtime/task-status.ts`, `src/runtime/task-registry.ts`, `src/runtime/subprocess.ts` — task lifecycle (`setStatus` contract, terminal-state idempotency)
- `src/runtime/orphan-reaper.ts`, `src/runtime/pid-file.ts`, `src/lib/kill-tree.ts` — orphan reaper (per-instance PID files, spawner-liveness + identity gates)
- `src/index.ts` — plugin wiring; any change to factory invocation or singleton key

For files outside this list, "load-bearing" means any change that could alter subprocess lifecycle, tool schema shape, or plugin initialization order.

API shape (`{subject, fact <200 chars, citations, reason}`), recommended subjects, citation format, and the full seeding pattern: see `docs/research/copilot-memory-experiment-2026-05-03.md`.

Verify a memory before storing: re-read the cited code in this session and only commit facts that hold. The system rechecks citations on use; memories with stale citations are silently dropped.

## Changeset Policy

This package uses `0.x` unstable versioning. User-visible changes require a `.changeset/*.md` entry with a `minor` bump (not `patch`).
