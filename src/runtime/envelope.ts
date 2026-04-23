/**
 * Envelope builder for Copilot delegation results.
 *
 * Folds ParsedEvent[] into the structured output envelope returned by
 * `copilot_output`. Every field is optional-safe — missing data degrades
 * gracefully rather than erroring.
 */

import type { ParsedEvent } from './jsonl-parser'

/** Status of a delegated Copilot task. */
export type TaskStatus = 'running' | 'complete' | 'failed' | 'cancelled'

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
  exitCode?: number
  agentName?: string
  modelName?: string
  errorText?: string
  timedOut?: boolean
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
}

/** Extract the last assistant message content from events. */
function extractFinalMessage(events: ParsedEvent[]): string | undefined {
  const messages = events.filter((e) => e.type === 'message')
  if (messages.length === 0) return undefined

  // Take the last message event
  const last = messages[messages.length - 1]
  const content = last.data.content as string | undefined
  return content && content.length > 0 ? content : undefined
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
    exitCode,
    agentName,
    modelName,
    errorText,
    timedOut,
  } = input

  const durationMs = Date.now() - startedAt
  const finalMessage = extractFinalMessage(events)
  const toolCalls = aggregateToolCalls(events)
  const tokens = extractTokens(events)

  const envelope: OutputEnvelope = {
    task_id: taskId,
    status,
    duration_ms: durationMs,
    events_count: events.length,
  }

  if (exitCode !== undefined) envelope.exit_code = exitCode
  if (agentName) envelope.agent = agentName
  if (modelName) envelope.model = modelName
  if (finalMessage) envelope.final_message = finalMessage
  if (toolCalls.length > 0) envelope.tool_calls_summary = toolCalls
  if (tokens) envelope.tokens = tokens
  if (errorText) envelope.error = errorText
  if (timedOut) envelope.timed_out = timedOut

  return envelope
}
