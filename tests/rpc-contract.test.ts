import { describe, expect, it } from 'bun:test'
import {
  HealthResponseSchema,
  PortFileSchema,
  TasksCancelRequestSchema,
  TasksCancelResponseSchema,
  TasksListResponseSchema,
} from '../src/runtime/rpc-contract'

const validTask = {
  taskId: 'cpl_12345678',
  status: 'running',
  agent: 'default',
  model: 'gpt-5',
  elapsedMs: 1234,
  toolCallCount: 2,
  startedAt: 1_714_400_000_000,
}

const validPortFile = {
  port: 43123,
  pid: 12345,
  token: 'token-123',
}

describe('rpc contract', () => {
  it('accepts an empty tasks list', () => {
    expect(TasksListResponseSchema.parse({ tasks: [] })).toEqual({ tasks: [] })
  })

  it('round-trips a populated row through JSON and re-validates it', () => {
    const parsed = TasksListResponseSchema.parse({ tasks: [validTask] })
    const roundTripped = JSON.parse(JSON.stringify(parsed))

    expect(TasksListResponseSchema.parse(roundTripped)).toEqual(parsed)
  })

  it('accepts the health and cancel response happy paths', () => {
    expect(HealthResponseSchema.parse({ ok: true, version: '0.9.0' })).toEqual({
      ok: true,
      version: '0.9.0',
    })

    expect(TasksCancelResponseSchema.parse({ cancelled: true })).toEqual({
      cancelled: true,
    })
  })

  it('rejects task ids without the cpl_ prefix', () => {
    const result = TasksListResponseSchema.safeParse({
      tasks: [{ ...validTask, taskId: 'task_12345678' }],
    })

    expect(result.success).toBe(false)
  })

  it('rejects negative and float elapsedMs values', () => {
    const negative = TasksListResponseSchema.safeParse({
      tasks: [{ ...validTask, elapsedMs: -1 }],
    })
    const float = TasksListResponseSchema.safeParse({
      tasks: [{ ...validTask, elapsedMs: 1.5 }],
    })

    expect(negative.success).toBe(false)
    expect(float.success).toBe(false)
  })

  it('requires a non-empty token in the port file and rejects missing token', () => {
    const emptyToken = PortFileSchema.safeParse({
      ...validPortFile,
      token: '',
    })
    const missingToken = PortFileSchema.safeParse({
      port: validPortFile.port,
      pid: validPortFile.pid,
    })

    expect(emptyToken.success).toBe(false)
    expect(missingToken.success).toBe(false)
  })

  it('fails empty cancel requests with a required taskId field error', () => {
    const result = TasksCancelRequestSchema.safeParse({})

    expect(result.success).toBe(false)

    if (result.success) {
      throw new Error('Expected empty cancel request to fail validation')
    }

    expect(
      result.error.issues.some((issue) => issue.path[0] === 'taskId'),
    ).toBe(true)
  })

  it('rejects unknown extra fields on every schema', () => {
    expect(
      HealthResponseSchema.safeParse({
        ok: true,
        version: '0.9.0',
        extra: true,
      }).success,
    ).toBe(false)

    expect(
      TasksListResponseSchema.safeParse({
        tasks: [],
        extra: true,
      }).success,
    ).toBe(false)

    expect(
      TasksListResponseSchema.safeParse({
        tasks: [{ ...validTask, extra: true }],
      }).success,
    ).toBe(false)

    expect(
      TasksCancelRequestSchema.safeParse({
        taskId: validTask.taskId,
        extra: true,
      }).success,
    ).toBe(false)

    expect(
      TasksCancelResponseSchema.safeParse({
        cancelled: true,
        extra: true,
      }).success,
    ).toBe(false)

    expect(
      PortFileSchema.safeParse({
        ...validPortFile,
        extra: true,
      }).success,
    ).toBe(false)
  })
})
