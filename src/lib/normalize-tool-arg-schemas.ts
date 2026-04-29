import type { ToolDefinition } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin/tool'

/**
 * Internal shape of a Zod schema's `_zod` slot, narrowed to the override hook
 * we patch. Zod 4 stores each schema's runtime metadata under `_zod` and the
 * host serializer calls `_zod.toJSONSchema?.()` first when walking schemas.
 */
interface ZodOverrideTarget {
  _zod: {
    toJSONSchema?: () => unknown
  }
}

/**
 * Removes the `$schema` field from the root of a JSON Schema. Some host-side
 * validators reject standard JSON Schema metadata fields they don't recognize,
 * so trimming `$schema` keeps the override output minimal and broadly accepted.
 */
function stripRootJsonSchemaFields(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  const { $schema: _schema, ...rest } = jsonSchema
  return rest
}

/**
 * Patches a Zod schema's `_zod.toJSONSchema` so OpenCode's host runtime
 * receives a JSON Schema produced by THIS plugin's own zod (with full
 * `.describe()` metadata intact) instead of falling through to the host's
 * zod, which lives in a different module instance and cannot see the plugin's
 * metadata registry.
 *
 * Without this override, every per-parameter description attached via
 * `.describe()` is silently dropped from the tool catalog delivered to LLMs.
 *
 * The override deletes itself before delegating to the plugin-local
 * serializer to avoid recursing back into itself, and restores itself in a
 * `finally` block so subsequent calls work the same way.
 *
 * Pattern borrowed from `@cortexkit/opencode-magic-context`.
 */
function attachJsonSchemaOverride(schema: unknown): void {
  const internals = (schema as ZodOverrideTarget)._zod
  if (!internals || typeof internals.toJSONSchema === 'function') return
  // Exceptions thrown by `tool.schema.toJSONSchema(schema)` propagate to the
  // caller; the `finally` block restores the override so subsequent calls
  // remain idempotent even after a failure.
  internals.toJSONSchema = () => {
    const original = internals.toJSONSchema
    delete internals.toJSONSchema
    try {
      return stripRootJsonSchemaFields(
        tool.schema.toJSONSchema(
          schema as Parameters<typeof tool.schema.toJSONSchema>[0],
        ) as Record<string, unknown>,
      )
    } finally {
      internals.toJSONSchema = original
    }
  }
}

/**
 * Walks a tool definition's `args` map and patches each schema with a
 * JSON Schema override (see {@link attachJsonSchemaOverride}). Mutates and
 * returns the same definition for fluent composition:
 *
 * ```ts
 * const tool = normalizeToolArgSchemas(createDelegateTool({...}))
 * ```
 */
export function normalizeToolArgSchemas<
  TDefinition extends Pick<ToolDefinition, 'args'>,
>(toolDefinition: TDefinition): TDefinition {
  for (const schema of Object.values(toolDefinition.args)) {
    attachJsonSchemaOverride(schema)
  }
  return toolDefinition
}
