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

## Changeset Policy

This package uses `0.x` unstable versioning. User-visible changes require a `.changeset/*.md` entry with a `minor` bump (not `patch`).
