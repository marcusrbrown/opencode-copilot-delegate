import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ParsedEvent, parseJsonlLine } from '../src/runtime/jsonl-parser'

const fixturesDir = join(import.meta.dir, 'fixtures')

describe('parseJsonlLine', () => {
  describe('event type normalization', () => {
    it('should parse an assistant.message event as type "message"', () => {
      // Given a JSONL line with type "assistant.message"
      const line = JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: 'msg-1',
          content: 'Hello world',
          toolRequests: [],
          interactionId: 'int-1',
          outputTokens: 10,
          requestId: 'req-1',
        },
        id: 'evt-1',
        timestamp: '2026-04-23T20:28:05.660Z',
        parentId: 'parent-1',
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should be categorized as "message"
      expect(result.type).toBe('message')
      expect(result.data.content).toBe('Hello world')
      expect(result.data.toolRequests).toEqual([])
      expect(result.raw.type).toBe('assistant.message')
    })

    it('should parse a tool.execution_start event as type "tool_use"', () => {
      // Given a JSONL line with type "tool.execution_start"
      const line = JSON.stringify({
        type: 'tool.execution_start',
        data: {
          toolCallId: 'tc-1',
          toolName: 'view',
          arguments: { path: '/some/file.ts' },
        },
        id: 'evt-2',
        timestamp: '2026-04-23T20:28:00.947Z',
        parentId: 'parent-2',
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should be categorized as "tool_use"
      expect(result.type).toBe('tool_use')
      expect(result.data.toolName).toBe('view')
    })

    it('should parse a tool.execution_complete event as type "tool_result"', () => {
      // Given a JSONL line with type "tool.execution_complete"
      const line = JSON.stringify({
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'tc-1',
          model: 'claude-haiku-4.5',
          interactionId: 'int-1',
          success: true,
          result: { content: 'file contents here' },
        },
        id: 'evt-3',
        timestamp: '2026-04-23T20:28:00.955Z',
        parentId: 'parent-3',
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should be categorized as "tool_result"
      expect(result.type).toBe('tool_result')
      expect(result.data.success).toBe(true)
    })

    it('should parse a result event as type "usage"', () => {
      // Given a JSONL line with type "result"
      const line = JSON.stringify({
        type: 'result',
        timestamp: '2026-04-23T20:28:05.682Z',
        sessionId: 'session-1',
        exitCode: 0,
        usage: {
          premiumRequests: 0.33,
          totalApiDurationMs: 11111,
          sessionDurationMs: 17483,
          codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
        },
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should be categorized as "usage"
      expect(result.type).toBe('usage')
      expect(result.data.exitCode).toBe(0)
      expect(result.data.usage.totalApiDurationMs).toBe(11111)
    })

    it('should parse session.* events as type "unknown"', () => {
      // Given a JSONL line with a session event type
      const line = JSON.stringify({
        type: 'session.mcp_server_status_changed',
        data: { serverName: 'github-mcp-server', status: 'connected' },
        id: 'evt-4',
        timestamp: '2026-04-23T20:27:49.395Z',
        parentId: 'parent-4',
        ephemeral: true,
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should be categorized as "unknown" (not relevant to envelope)
      expect(result.type).toBe('unknown')
      expect(result.raw.type).toBe('session.mcp_server_status_changed')
    })

    it('should parse assistant.*_delta events as type "unknown"', () => {
      // Given a streaming delta event
      const line = JSON.stringify({
        type: 'assistant.message_delta',
        data: { messageId: 'msg-1', deltaContent: 'Hello' },
        id: 'evt-5',
        timestamp: '2026-04-23T20:28:04.709Z',
        parentId: 'parent-5',
        ephemeral: true,
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then streaming deltas are "unknown" — we use full messages, not deltas
      expect(result.type).toBe('unknown')
    })

    it('should parse assistant.turn_start/turn_end as type "unknown"', () => {
      // Given turn boundary events
      const startLine = JSON.stringify({
        type: 'assistant.turn_start',
        data: { turnId: '0', interactionId: 'int-1' },
        id: 'evt-6',
        timestamp: '2026-04-23T20:27:53.976Z',
        parentId: 'parent-6',
      })

      // When parsed
      const result = parseJsonlLine(startLine)

      // Then turn boundaries are "unknown"
      expect(result.type).toBe('unknown')
    })
  })

  describe('malformed input handling', () => {
    it('should return type "unknown" for non-JSON input', () => {
      // Given a line that is not valid JSON
      const line = 'this is not json at all'

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should return unknown without throwing
      expect(result.type).toBe('unknown')
      expect(result.raw).toEqual({})
    })

    it('should return type "unknown" for empty string', () => {
      // Given an empty string
      const result = parseJsonlLine('')

      // Then it should return unknown without throwing
      expect(result.type).toBe('unknown')
    })

    it('should return type "unknown" for JSON without type field', () => {
      // Given valid JSON but missing the "type" field
      const line = JSON.stringify({ data: { foo: 'bar' }, id: 'evt-7' })

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should return unknown
      expect(result.type).toBe('unknown')
    })

    it('should return type "unknown" for JSON array (not object)', () => {
      // Given a JSON array instead of object
      const line = JSON.stringify([1, 2, 3])

      // When parsed
      const result = parseJsonlLine(line)

      // Then it should return unknown
      expect(result.type).toBe('unknown')
    })

    it('should return type "unknown" for JSON null value', () => {
      // Given a line that is valid JSON but null
      const result = parseJsonlLine('null')

      // Then it should return unknown without throwing
      expect(result.type).toBe('unknown')
      expect(result.raw).toEqual({})
    })
  })

  describe('ParsedEvent structure', () => {
    it('should include raw event data in the raw field', () => {
      // Given any valid JSONL event
      const rawEvent = {
        type: 'assistant.message',
        data: { messageId: 'msg-1', content: 'test', toolRequests: [] },
        id: 'evt-8',
        timestamp: '2026-04-23T20:28:05.660Z',
        parentId: 'parent-8',
      }
      const line = JSON.stringify(rawEvent)

      // When parsed
      const result = parseJsonlLine(line)

      // Then the raw field preserves the original event
      expect(result.raw.type).toBe('assistant.message')
      expect(result.raw.id).toBe('evt-8')
    })

    it('should extract message content with tool requests', () => {
      // Given an assistant.message with tool requests
      const line = JSON.stringify({
        type: 'assistant.message',
        data: {
          messageId: 'msg-1',
          content: '',
          toolRequests: [
            {
              toolCallId: 'tc-1',
              name: 'view',
              arguments: { path: '/some/file.ts' },
              type: 'function',
              intentionSummary: 'view the file',
            },
          ],
          outputTokens: 149,
          requestId: 'req-1',
        },
        id: 'evt-9',
        timestamp: '2026-04-23T20:28:00.947Z',
        parentId: 'parent-9',
      })

      // When parsed
      const result = parseJsonlLine(line)

      // Then tool requests are extracted into data
      expect(result.type).toBe('message')
      expect(result.data.toolRequests).toHaveLength(1)
      expect(result.data.toolRequests[0].name).toBe('view')
    })
  })

  describe('fixture integration', () => {
    it('should parse all lines from happy-path.jsonl without throwing', () => {
      // Given the happy-path fixture
      const content = readFileSync(
        join(fixturesDir, 'happy-path.jsonl'),
        'utf-8',
      )
      const lines = content.split('\n').filter((l) => l.trim().length > 0)

      // When each line is parsed
      const events: ParsedEvent[] = []
      for (const line of lines) {
        // Then no line should throw
        expect(() => {
          events.push(parseJsonlLine(line))
        }).not.toThrow()
      }

      // And we should get at least one "message" and one "usage" event
      const messages = events.filter((e) => e.type === 'message')
      const usage = events.filter((e) => e.type === 'usage')
      expect(messages.length).toBeGreaterThanOrEqual(1)
      expect(usage.length).toBe(1)
    })

    it('should parse model-error.jsonl without throwing', () => {
      // Given the model-error fixture (only 1 line, no real content)
      const content = readFileSync(
        join(fixturesDir, 'model-error.jsonl'),
        'utf-8',
      )
      const lines = content.split('\n').filter((l) => l.trim().length > 0)

      // When each line is parsed
      const events: ParsedEvent[] = []
      for (const line of lines) {
        expect(() => {
          events.push(parseJsonlLine(line))
        }).not.toThrow()
      }

      // Then we get events but no "message" type (error was on stderr)
      const messages = events.filter((e) => e.type === 'message')
      expect(messages.length).toBe(0)
    })

    it('should handle multi-tool.jsonl with malformed lines gracefully', () => {
      // Given the multi-tool fixture (some lines have unescaped newlines)
      const content = readFileSync(
        join(fixturesDir, 'multi-tool.jsonl'),
        'utf-8',
      )
      const lines = content.split('\n').filter((l) => l.trim().length > 0)

      // When each line is parsed
      const events: ParsedEvent[] = []
      for (const line of lines) {
        // Then no line should throw — malformed lines return "unknown"
        expect(() => {
          events.push(parseJsonlLine(line))
        }).not.toThrow()
      }

      // And we should still get some valid events
      expect(events.length).toBeGreaterThan(0)
      // Some lines are malformed fragments and will be "unknown"
      const unknowns = events.filter((e) => e.type === 'unknown')
      expect(unknowns.length).toBeGreaterThan(0)
    })
  })
})
