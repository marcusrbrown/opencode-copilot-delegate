import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildEnvelope, type EnvelopeInput } from '../src/runtime/envelope'
import type { ParsedEvent } from '../src/runtime/jsonl-parser'
import { parseJsonlLine } from '../src/runtime/jsonl-parser'

const fixturesDir = join(import.meta.dir, 'fixtures')

/** Parse a fixture file into ParsedEvents. */
function parseFixture(filename: string): ParsedEvent[] {
  const content = readFileSync(join(fixturesDir, filename), 'utf-8')
  return content
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map(parseJsonlLine)
}

/** Helper to create a minimal EnvelopeInput. */
function makeInput(overrides: Partial<EnvelopeInput> = {}): EnvelopeInput {
  return {
    taskId: 'cpl_test-1234',
    events: [],
    status: 'running',
    startedAt: Date.now() - 5000,
    ...overrides,
  }
}

describe('buildEnvelope', () => {
  describe('required keys', () => {
    it('should return an object with all required envelope keys', () => {
      // Given minimal input with no events
      const input = makeInput({ status: 'running', events: [] })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then all required keys must be present
      expect(envelope.task_id).toBe('cpl_test-1234')
      expect(envelope.status).toBe('running')
      expect(typeof envelope.duration_ms).toBe('number')
      expect(typeof envelope.events_count).toBe('number')
      expect(envelope.events_count).toBe(0)
    })

    it('should compute duration_ms from startedAt and endedAt', () => {
      // Given input with known startedAt and endedAt
      const input = makeInput({ startedAt: 1000, endedAt: 4000 })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then duration_ms should be exactly 3000ms (deterministic)
      expect(envelope.duration_ms).toBe(3000)
    })

    it('should fall back to Date.now() when endedAt is not provided', () => {
      // Given input with only startedAt
      const now = Date.now()
      const input = makeInput({ startedAt: now - 1000 })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then duration_ms should be approximately 1000ms
      expect(envelope.duration_ms).toBeGreaterThanOrEqual(900)
      expect(envelope.duration_ms).toBeLessThanOrEqual(1200)
    })
  })

  describe('happy path', () => {
    it('should extract final_message from happy-path fixture', () => {
      // Given events from the happy-path fixture
      const events = parseFixture('happy-path.jsonl')
      const input = makeInput({
        events,
        status: 'complete',
        exitCode: 0,
        startedAt: Date.now() - 17000,
      })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then it should have a non-empty final_message
      expect(envelope.final_message).toBeTruthy()
      expect(typeof envelope.final_message).toBe('string')
      expect((envelope.final_message as string).length).toBeGreaterThan(0)
    })

    it('should count events correctly', () => {
      // Given events from the happy-path fixture
      const events = parseFixture('happy-path.jsonl')
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then events_count should match input events length
      expect(envelope.events_count).toBe(events.length)
    })

    it('should set exit_code from input', () => {
      // Given input with exit_code 0
      const input = makeInput({ status: 'complete', exitCode: 0 })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then exit_code should be 0
      expect(envelope.exit_code).toBe(0)
    })

    it('should pass through agent and model names', () => {
      // Given input with agent and model
      const input = makeInput({
        status: 'complete',
        agentName: 'explore',
        modelName: 'claude-haiku-4.5',
      })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then agent and model should be present
      expect(envelope.agent).toBe('explore')
      expect(envelope.model).toBe('claude-haiku-4.5')
    })
  })

  describe('tool call aggregation', () => {
    it('should aggregate tool calls from events with tool_use type', () => {
      // Given events that include tool_use events
      const events: ParsedEvent[] = [
        {
          type: 'tool_use',
          data: {
            toolCallId: 'tc-1',
            toolName: 'view',
            arguments: { path: '/f1.ts' },
          },
          raw: { type: 'tool.execution_start' },
        },
        {
          type: 'tool_result',
          data: {
            toolCallId: 'tc-1',
            success: true,
            result: { content: 'ok' },
          },
          raw: { type: 'tool.execution_complete' },
        },
        {
          type: 'tool_use',
          data: {
            toolCallId: 'tc-2',
            toolName: 'glob',
            arguments: { pattern: 'src/**' },
          },
          raw: { type: 'tool.execution_start' },
        },
        {
          type: 'tool_result',
          data: {
            toolCallId: 'tc-2',
            success: true,
            result: { content: 'files' },
          },
          raw: { type: 'tool.execution_complete' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then tool_calls_summary should list both tools
      expect(envelope.tool_calls_summary).toHaveLength(2)
      expect(envelope.tool_calls_summary?.[0].name).toBe('view')
      expect(envelope.tool_calls_summary?.[0].success).toBe(true)
      expect(envelope.tool_calls_summary?.[1].name).toBe('glob')
    })
  })

  describe('usage extraction', () => {
    it('should extract tokens from usage event', () => {
      // Given events with a usage (result) event
      const events: ParsedEvent[] = [
        {
          type: 'usage',
          data: {
            exitCode: 0,
            usage: {
              premiumRequests: 0.33,
              totalApiDurationMs: 11111,
              sessionDurationMs: 17483,
            },
          },
          raw: { type: 'result' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then tokens should be extracted from usage
      expect(envelope.tokens).toBeDefined()
      expect(envelope.tokens?.totalApiDurationMs).toBe(11111)
    })

    it('should degrade gracefully when no usage event present', () => {
      // Given events with no usage event
      const events: ParsedEvent[] = [
        {
          type: 'message',
          data: { content: 'Hello', toolRequests: [] },
          raw: { type: 'assistant.message' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then tokens should be undefined, not an error
      expect(envelope.tokens).toBeUndefined()
    })
  })

  describe('edge cases', () => {
    it('should select last non-empty message when last message has empty content', () => {
      // Given messages where the last has empty content (tool-request scaffolding)
      const events: ParsedEvent[] = [
        {
          type: 'message',
          data: { content: 'This is the real answer', toolRequests: [] },
          raw: { type: 'assistant.message' },
        },
        {
          type: 'message',
          data: { content: '', toolRequests: [{ name: 'view' }] },
          raw: { type: 'assistant.message' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then final_message should be the earlier non-empty message
      expect(envelope.final_message).toBe('This is the real answer')
    })

    it('should return undefined final_message when all messages have empty content', () => {
      // Given only empty-content messages
      const events: ParsedEvent[] = [
        {
          type: 'message',
          data: { content: '', toolRequests: [{ name: 'view' }] },
          raw: { type: 'assistant.message' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then final_message should be undefined
      expect(envelope.final_message).toBeUndefined()
    })

    it('should handle tool_use with no matching tool_result', () => {
      // Given a tool_use event with no corresponding tool_result
      const events: ParsedEvent[] = [
        {
          type: 'tool_use',
          data: { toolCallId: 'tc-orphan', toolName: 'bash' },
          raw: { type: 'tool.execution_start' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then tool_calls_summary should list it with success undefined
      expect(envelope.tool_calls_summary).toHaveLength(1)
      expect(envelope.tool_calls_summary?.[0].name).toBe('bash')
      expect(envelope.tool_calls_summary?.[0].success).toBeUndefined()
    })

    it('should handle malformed usage data gracefully', () => {
      // Given a usage event where usage is a string instead of an object
      const events: ParsedEvent[] = [
        {
          type: 'usage',
          data: { exitCode: 0, usage: 'not an object' },
          raw: { type: 'result' },
        },
      ]
      const input = makeInput({ events, status: 'complete' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then tokens should be undefined (graceful degradation)
      expect(envelope.tokens).toBeUndefined()
    })
  })

  describe('error handling', () => {
    it('should set error field when status is failed', () => {
      // Given failed status with error text
      const input = makeInput({
        status: 'failed',
        exitCode: 1,
        errorText: 'Model "nonexistent" is not available.',
      })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then error should contain the error text
      expect(envelope.status).toBe('failed')
      expect(envelope.error).toBe('Model "nonexistent" is not available.')
      expect(envelope.exit_code).toBe(1)
    })

    it('should handle cancelled status', () => {
      // Given cancelled status
      const input = makeInput({ status: 'cancelled' })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then status should be cancelled
      expect(envelope.status).toBe('cancelled')
    })

    it('should expose cancelling tasks as cancelled in public output envelopes', () => {
      // Given a task in the internal cancellation transition state
      const input = makeInput({ status: 'cancelling' })

      // When the public output envelope is built
      const envelope = buildEnvelope(input)

      // Then copilot_output keeps the existing cancelled public contract
      expect(envelope.status).toBe('cancelled')
    })

    it('should set timed_out when specified', () => {
      // Given a timed out input
      const input = makeInput({ status: 'failed', timedOut: true })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then timed_out should be true
      expect(envelope.timed_out).toBe(true)
    })
  })

  describe('fixture integration', () => {
    it('should build a complete envelope from happy-path fixture', () => {
      // Given the full happy-path events
      const events = parseFixture('happy-path.jsonl')
      const input = makeInput({
        events,
        status: 'complete',
        exitCode: 0,
        modelName: 'claude-haiku-4.5',
        startedAt: Date.now() - 17000,
      })

      // When the envelope is built
      const envelope = buildEnvelope(input)

      // Then all fields should be populated correctly
      expect(envelope.status).toBe('complete')
      expect(envelope.exit_code).toBe(0)
      expect(envelope.model).toBe('claude-haiku-4.5')
      expect(envelope.final_message).toBeTruthy()
      expect(envelope.events_count).toBeGreaterThan(0)
      // Should have at least one tool call (view was used)
      expect(envelope.tool_calls_summary?.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('origin discriminator pass-through (S2 Unit 1)', () => {
    // Each task carries an `origin` field on the registry; the envelope
    // mirrors it so consumers can branch on the source of the work
    // (delegate vs resume vs connect) without re-reading the registry.
    // Tests cover the three legal values plus the back-compat default.

    it("includes origin: 'spawn' when input.origin is 'spawn'", () => {
      const envelope = buildEnvelope(makeInput({ origin: 'spawn' }))
      expect(envelope.origin).toBe('spawn')
    })

    it("includes origin: 'resume' when input.origin is 'resume'", () => {
      const envelope = buildEnvelope(makeInput({ origin: 'resume' }))
      expect(envelope.origin).toBe('resume')
    })

    it("includes origin: 'connect' when input.origin is 'connect'", () => {
      const envelope = buildEnvelope(makeInput({ origin: 'connect' }))
      expect(envelope.origin).toBe('connect')
    })

    it("defaults envelope.origin to 'spawn' when input.origin is omitted", () => {
      // Back-compat for fixtures and call sites that predate Unit 1: an
      // input without origin must still produce a valid envelope, and the
      // implicit value matches the default the registry assigns.
      const envelope = buildEnvelope(makeInput({}))
      expect(envelope.origin).toBe('spawn')
    })
  })

  describe('copilot_session_id pass-through (S2 Unit 1)', () => {
    // copilotSessionId is captured from the JSONL `result` event during
    // task lifecycle (see subprocess tests). The envelope mirrors it so
    // consumers can recover the upstream session ID without scanning
    // events themselves.
    it('includes copilot_session_id when input.copilotSessionId is present', () => {
      const envelope = buildEnvelope(
        makeInput({
          copilotSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        }),
      )
      expect(envelope.copilot_session_id).toBe(
        'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      )
    })

    it('omits copilot_session_id when input.copilotSessionId is undefined', () => {
      const envelope = buildEnvelope(makeInput({}))
      expect(envelope.copilot_session_id).toBeUndefined()
    })
  })
})
