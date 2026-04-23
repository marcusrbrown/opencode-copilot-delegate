/**
 * Copilot CLI JSONL event parser.
 *
 * Parses individual JSONL lines from `copilot --output-format json` stdout
 * into normalized ParsedEvent objects. Defensive: never throws on malformed
 * input — returns type "unknown" instead.
 */

/** Normalized event types relevant to the output envelope. */
export type ParsedEventType =
  | 'message'
  | 'tool_use'
  | 'tool_result'
  | 'usage'
  | 'error'
  | 'unknown'

/** A parsed and normalized JSONL event. */
export type ParsedEvent = {
  /** Normalized event type for envelope construction. */
  type: ParsedEventType
  /** Extracted payload fields relevant to this event type. */
  data: Record<string, unknown>
  /** Original raw parsed JSON object (empty object if parse failed). */
  raw: Record<string, unknown>
}

/** Map raw Copilot CLI event types to normalized ParsedEvent types. */
function classifyEventType(rawType: string): ParsedEventType {
  switch (rawType) {
    case 'assistant.message':
      return 'message'
    case 'tool.execution_start':
      return 'tool_use'
    case 'tool.execution_complete':
      return 'tool_result'
    case 'result':
      return 'usage'
    default:
      return 'unknown'
  }
}

/** Extract relevant data fields based on event type. */
function extractData(
  type: ParsedEventType,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const rawData = (raw.data ?? {}) as Record<string, unknown>

  switch (type) {
    case 'message':
      return {
        messageId: rawData.messageId,
        content: rawData.content,
        toolRequests: rawData.toolRequests ?? [],
        outputTokens: rawData.outputTokens,
        requestId: rawData.requestId,
        interactionId: rawData.interactionId,
      }
    case 'tool_use':
      return {
        toolCallId: rawData.toolCallId,
        toolName: rawData.toolName,
        arguments: rawData.arguments,
      }
    case 'tool_result':
      return {
        toolCallId: rawData.toolCallId,
        model: rawData.model,
        interactionId: rawData.interactionId,
        success: rawData.success,
        result: rawData.result,
      }
    case 'usage':
      return {
        sessionId: raw.sessionId,
        exitCode: raw.exitCode,
        usage: raw.usage ?? {},
      }
    default:
      return rawData
  }
}

/**
 * Parse a single JSONL line into a normalized ParsedEvent.
 *
 * Never throws. Malformed input returns `{ type: 'unknown', data: {}, raw: {} }`.
 */
export function parseJsonlLine(line: string): ParsedEvent {
  if (!line || line.trim().length === 0) {
    return { type: 'unknown', data: {}, raw: {} }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { type: 'unknown', data: {}, raw: {} }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { type: 'unknown', data: {}, raw: {} }
  }

  const raw = parsed as Record<string, unknown>
  const rawType = raw.type

  if (typeof rawType !== 'string') {
    return { type: 'unknown', data: {}, raw }
  }

  const type = classifyEventType(rawType)
  const data = extractData(type, raw)

  return { type, data, raw }
}
