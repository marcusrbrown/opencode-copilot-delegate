import { describe, expect, test } from 'bun:test'
import { tool } from '@opencode-ai/plugin/tool'
import { normalizeToolArgSchemas } from '../src/lib/normalize-tool-arg-schemas'

type ZodInternals = {
  _zod: { toJSONSchema?: () => unknown }
}

describe('normalizeToolArgSchemas', () => {
  test('attaches a toJSONSchema override on each arg schema', () => {
    const a = tool.schema.string().describe('field a')
    const b = tool.schema.number().optional().describe('field b')
    const def = { args: { a, b } }

    normalizeToolArgSchemas(def)

    expect(typeof (a as unknown as ZodInternals)._zod.toJSONSchema).toBe(
      'function',
    )
    expect(typeof (b as unknown as ZodInternals)._zod.toJSONSchema).toBe(
      'function',
    )
  })

  test('override surfaces description on a leaf schema', () => {
    const schema = tool.schema.string().describe('the description text')
    normalizeToolArgSchemas({ args: { field: schema } })

    const result = (
      schema as unknown as ZodInternals
    )._zod.toJSONSchema?.() as Record<string, unknown>
    expect(result.description).toBe('the description text')
    expect(result.type).toBe('string')
  })

  test('override surfaces description on an .optional() wrapped schema', () => {
    const schema = tool.schema
      .string()
      .optional()
      .describe('optional field description')
    normalizeToolArgSchemas({ args: { field: schema } })

    const result = (
      schema as unknown as ZodInternals
    )._zod.toJSONSchema?.() as Record<string, unknown>
    expect(result.description).toBe('optional field description')
  })

  test('override surfaces description on an array().optional() wrapped schema', () => {
    const schema = tool.schema
      .string()
      .array()
      .optional()
      .describe('array description')
    normalizeToolArgSchemas({ args: { field: schema } })

    const result = (
      schema as unknown as ZodInternals
    )._zod.toJSONSchema?.() as Record<string, unknown>
    expect(result.description).toBe('array description')
  })

  test('override strips the $schema root field', () => {
    const schema = tool.schema.string().describe('foo')
    normalizeToolArgSchemas({ args: { field: schema } })

    const result = (
      schema as unknown as ZodInternals
    )._zod.toJSONSchema?.() as Record<string, unknown>
    expect(result.$schema).toBeUndefined()
  })

  test('skips schemas that already have a toJSONSchema override', () => {
    const schema = tool.schema.string().describe('foo')
    const sentinel = () => ({ custom: true })
    ;(schema as unknown as ZodInternals)._zod.toJSONSchema = sentinel
    normalizeToolArgSchemas({ args: { field: schema } })

    expect((schema as unknown as ZodInternals)._zod.toJSONSchema).toBe(sentinel)
  })

  test('returns the same definition object for fluent composition', () => {
    const def = { args: { field: tool.schema.string() } }
    expect(normalizeToolArgSchemas(def)).toBe(def)
  })

  test('override is re-entrant — calling it from within itself does not infinite-loop', () => {
    const schema = tool.schema.string().describe('foo')
    normalizeToolArgSchemas({ args: { field: schema } })

    const override = (schema as unknown as ZodInternals)._zod.toJSONSchema
    expect(override).toBeDefined()
    // First call deletes itself, calls the host serializer, restores itself.
    // Second call should work the same way without throwing.
    const first = override?.() as Record<string, unknown>
    const second = override?.() as Record<string, unknown>
    expect(first.description).toBe('foo')
    expect(second.description).toBe('foo')
  })
})
