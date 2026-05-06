/**
 * Envelope builder for Copilot delegation results.
 *
 * Folds ParsedEvent[] into the structured output envelope returned by
 * `copilot_output`. Every field is optional-safe — missing data degrades
 * gracefully rather than erroring.
 */

import type { ParsedEvent } from './jsonl-parser'
import type { TaskOrigin } from './task-registry'

/** Status of a delegated Copilot task. */
export type TaskStatus =
  | 'running'
  | 'cancelling'
  | 'complete'
  | 'failed'
  | 'cancelled'

/** Summary of a single tool call made during the Copilot session. */
export type ToolCallSummary = {
  name: string
  toolCallId: string
  success?: boolean
}

/** Token/usage information from the Copilot session. */
export type TokenUsage = {
  premiumRequests?: number
  totalApiDurationMs?: number
  sessionDurationMs?: number
  [key: string]: unknown
}

/** Input for building the output envelope. */
export type EnvelopeInput = {
  taskId: string
  events: ParsedEvent[]
  status: TaskStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  agentName?: string
  modelName?: string
  errorText?: string
  timedOut?: boolean
  /** Source of the task — pass-through from `TaskState.origin`. */
  origin?: TaskOrigin
  /** Upstream Copilot session UUID — pass-through from `TaskState`. */
  copilotSessionId?: string
}

/** The structured result envelope returned by `copilot_output`. */
export type OutputEnvelope = {
  task_id: string
  status: TaskStatus
  exit_code?: number
  agent?: string
  model?: string
  duration_ms: number
  tokens?: TokenUsage
  final_message?: string
  tool_calls_summary?: ToolCallSummary[]
  error?: string
  timed_out?: boolean
  events_count: number
  /**
   * Source of the task. Always populated; defaults to `'spawn'` for inputs
   * that predate the discriminator (back-compat). Consumers branch on this
   * to distinguish a fresh delegation from a resumed/connected session
   * without re-reading the registry.
   */
  origin: TaskOrigin
  /**
   * Upstream Copilot session UUID, when known. Captured from the JSONL
   * `result` event during the task lifecycle. Omitted when the subprocess
   * never emitted a `result` event (e.g., killed early or crashed).
   */
  copilot_session_id?: string
}

function outputStatus(status: TaskStatus): OutputEnvelope['status'] {
  return status === 'cancelling' ? 'cancelled' : status
}

/** Extract the last non-empty assistant message content from events. */
function extractFinalMessage(events: ParsedEvent[]): string | undefined {
  const messages = events.filter((e) => e.type === 'message')
  if (messages.length === 0) return undefined

  // Walk backwards to find the last message with non-empty content
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].data.content as string | undefined
    if (content && content.length > 0) return content
  }
  return undefined
}

/** Aggregate tool call summaries from tool_use and tool_result events. */
function aggregateToolCalls(events: ParsedEvent[]): ToolCallSummary[] {
  const toolUses = events.filter((e) => e.type === 'tool_use')
  const toolResults = new Map<string, boolean>()

  for (const result of events.filter((e) => e.type === 'tool_result')) {
    const toolCallId = result.data.toolCallId as string
    if (toolCallId) {
      toolResults.set(toolCallId, (result.data.success as boolean) ?? false)
    }
  }

  return toolUses.map((use) => {
    const toolCallId = use.data.toolCallId as string
    return {
      name: (use.data.toolName as string) ?? 'unknown',
      toolCallId: toolCallId ?? 'unknown',
      success: toolResults.get(toolCallId),
    }
  })
}

/** Extract token usage from the usage (result) event. */
function extractTokens(events: ParsedEvent[]): TokenUsage | undefined {
  const usageEvents = events.filter((e) => e.type === 'usage')
  if (usageEvents.length === 0) return undefined

  const last = usageEvents[usageEvents.length - 1]
  const usage = last.data.usage as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return undefined

  return usage as TokenUsage
}

/**
 * Build the structured output envelope from parsed events and task metadata.
 *
 * Every field degrades gracefully — missing events, empty arrays, and absent
 * usage data produce undefined fields rather than errors.
 */
export function buildEnvelope(input: EnvelopeInput): OutputEnvelope {
  const {
    taskId,
    events,
    status,
    startedAt,
    endedAt,
    exitCode,
    agentName,
    modelName,
    errorText,
    timedOut,
    origin,
    copilotSessionId,
  } = input

  const durationMs = (endedAt ?? Date.now()) - startedAt
  const finalMessage = extractFinalMessage(events)
  const toolCalls = aggregateToolCalls(events)
  const tokens = extractTokens(events)

  const envelope: OutputEnvelope = {
    task_id: taskId,
    status: outputStatus(status),
    duration_ms: durationMs,
    events_count: events.length,
    // Default to 'spawn' for inputs that predate the discriminator so
    // existing call sites keep working without explicit origin (S2 Unit 1).
    origin: origin ?? 'spawn',
  }

  if (exitCode !== undefined) envelope.exit_code = exitCode
  if (agentName) envelope.agent = agentName
  if (modelName) envelope.model = modelName
  if (finalMessage) envelope.final_message = finalMessage
  if (toolCalls.length > 0) envelope.tool_calls_summary = toolCalls
  if (tokens) envelope.tokens = tokens
  if (errorText) envelope.error = errorText
  if (timedOut) envelope.timed_out = timedOut
  if (copilotSessionId) envelope.copilot_session_id = copilotSessionId

  return envelope
}
