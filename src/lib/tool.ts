import type { ToolContext, ToolResult } from '@opencode-ai/plugin/tool'
import { z } from 'zod'

/**
 * Host-free replacement for `tool()` from `@opencode-ai/plugin/tool`.
 *
 * The V1 host's `tool()` is an identity function with `tool.schema = z`.
 * Importing it at runtime makes `dist/index.js` depend on
 * `@opencode-ai/plugin`, so the plugin can't load on a host that doesn't
 * provide that package, such as an OpenCode V2 install (see
 * docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md, R3).
 *
 * This module keeps the same shape. It uses the plugin's own bundled zod
 * (>= 4.2, so V2 can consume the schemas directly as Standard Schema) and
 * imports only types from the host package. Argument descriptions still
 * reach V1 hosts below 1.15.1 through `normalizeToolArgSchemas`.
 */
export type ToolDefinition<Args extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: Args
  execute(
    args: z.infer<z.ZodObject<Args>>,
    context: ToolContext,
  ): Promise<ToolResult>
}

export function tool<Args extends z.ZodRawShape>(
  input: ToolDefinition<Args>,
): ToolDefinition<Args> {
  return input
}

tool.schema = z
