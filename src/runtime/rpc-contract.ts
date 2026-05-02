import { z } from 'zod'

const CopilotTaskIdSchema = z
  .string()
  .regex(/^cpl_.+$/, 'taskId must start with cpl_')

const TaskStatusSchema = z.enum([
  'running',
  'cancelling',
  'complete',
  'failed',
  'cancelled',
])

const TaskListItemSchema = z
  .object({
    taskId: CopilotTaskIdSchema,
    status: TaskStatusSchema,
    agent: z.string(),
    model: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative(),
  })
  .strict()

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    version: z.string().min(1),
  })
  .strict()

export const TasksListResponseSchema = z
  .object({
    tasks: z.array(TaskListItemSchema),
  })
  .strict()

export const TasksCancelRequestSchema = z
  .object({
    taskId: CopilotTaskIdSchema,
  })
  .strict()

export const TasksCancelResponseSchema = z
  .object({
    cancelled: z.boolean(),
    error: z.string().min(1).optional(),
  })
  .strict()

export const PortFileSchema = z
  .object({
    port: z.number().int().positive(),
    pid: z.number().int().positive(),
    token: z.string().min(1),
  })
  .strict()

export type HealthResponse = z.infer<typeof HealthResponseSchema>
export type TasksListResponse = z.infer<typeof TasksListResponseSchema>
export type TasksCancelRequest = z.infer<typeof TasksCancelRequestSchema>
export type TasksCancelResponse = z.infer<typeof TasksCancelResponseSchema>
export type PortFile = z.infer<typeof PortFileSchema>
