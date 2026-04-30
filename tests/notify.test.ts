import { afterEach, describe, expect, it } from 'bun:test'
import {
  incrementInFlight,
  type NotifyClient,
  type NotifyTaskInfo,
  notifyCompletion,
  resetInFlightCounters,
} from '../src/runtime/notify'

/** Create a mock client that records prompt, toast, and app.log calls. */
function mockClient(): NotifyClient & {
  promptCalls: Array<{ sessionId: string; noReply: boolean; text: string }>
  toastCalls: Array<{ message: string; variant: string }>
  logCalls: Array<unknown>
} {
  const promptCalls: Array<{
    sessionId: string
    noReply: boolean
    text: string
  }> = []
  const toastCalls: Array<{ message: string; variant: string }> = []
  const logCalls: Array<unknown> = []

  return {
    promptCalls,
    toastCalls,
    logCalls,
    session: {
      prompt: async (opts: {
        path: { id: string }
        body: {
          noReply: boolean
          parts: Array<{ type: string; text: string; synthetic: boolean }>
        }
      }) => {
        promptCalls.push({
          sessionId: opts.path.id,
          noReply: opts.body.noReply,
          text: opts.body.parts[0].text,
        })
      },
    },
    tui: {
      showToast: (opts: { body: { message: string; variant: string } }) => {
        toastCalls.push({
          message: opts.body.message,
          variant: opts.body.variant,
        })
      },
    },
    app: {
      log: (arg: unknown) => {
        logCalls.push(arg)
        return Promise.resolve()
      },
    },
  }
}

/** Create a minimal task info for notification. */
function makeTaskInfo(overrides: Partial<NotifyTaskInfo> = {}): NotifyTaskInfo {
  return {
    taskId: 'cpl_test-1234',
    parentSessionID: 'session-A',
    status: 'complete',
    agentName: undefined,
    modelName: undefined,
    startedAt: Date.now() - 5000,
    exitCode: 0,
    ...overrides,
  }
}

afterEach(() => {
  resetInFlightCounters()
})

describe('notification injection', () => {
  describe('noReply semantics', () => {
    it('should set noReply: true when other tasks remain in flight', async () => {
      // Given 3 in-flight tasks for session A
      const client = mockClient()
      incrementInFlight('session-A')
      incrementInFlight('session-A')
      incrementInFlight('session-A')

      // When the first task completes
      await notifyCompletion(client, makeTaskInfo())

      // Then noReply is true (2 tasks still running)
      expect(client.promptCalls).toHaveLength(1)
      expect(client.promptCalls[0].noReply).toBe(true)
    })

    it('should set noReply: false when the last task completes', async () => {
      // Given 1 in-flight task for session A
      const client = mockClient()
      incrementInFlight('session-A')

      // When the only task completes
      await notifyCompletion(client, makeTaskInfo())

      // Then noReply is false (forces parent turn)
      expect(client.promptCalls[0].noReply).toBe(false)
    })

    it('should always set noReply: false on failed status regardless of count', async () => {
      // Given 3 in-flight tasks
      const client = mockClient()
      incrementInFlight('session-A')
      incrementInFlight('session-A')
      incrementInFlight('session-A')

      // When a task fails (2 still running)
      await notifyCompletion(
        client,
        makeTaskInfo({ status: 'failed', exitCode: 1 }),
      )

      // Then noReply is false (failed always forces turn)
      expect(client.promptCalls[0].noReply).toBe(false)
    })

    it('should never leave noReply as undefined', async () => {
      // Given 1 in-flight task
      const client = mockClient()
      incrementInFlight('session-A')

      // When the task completes
      await notifyCompletion(client, makeTaskInfo())

      // Then noReply is explicitly boolean, not undefined
      expect(client.promptCalls[0].noReply).toBeDefined()
      expect(typeof client.promptCalls[0].noReply).toBe('boolean')
    })
  })

  describe('multi-session isolation', () => {
    it('should isolate in-flight counters per parent session', async () => {
      // Given session A has 2 tasks and session B has 1 task
      const client = mockClient()
      incrementInFlight('session-A')
      incrementInFlight('session-A')
      incrementInFlight('session-B')

      // When session A's first task completes
      await notifyCompletion(
        client,
        makeTaskInfo({ parentSessionID: 'session-A' }),
      )

      // Then A still has 1 task → noReply: true
      expect(client.promptCalls[0].noReply).toBe(true)

      // When session B's only task completes
      await notifyCompletion(
        client,
        makeTaskInfo({
          parentSessionID: 'session-B',
          taskId: 'cpl_test-5678',
        }),
      )

      // Then B's last task → noReply: false (independent of A's count)
      expect(client.promptCalls[1].noReply).toBe(false)

      // When session A's last task completes
      await notifyCompletion(
        client,
        makeTaskInfo({
          parentSessionID: 'session-A',
          taskId: 'cpl_test-9999',
        }),
      )

      // Then A's last task → noReply: false
      expect(client.promptCalls[2].noReply).toBe(false)
    })
  })

  describe('notification shape', () => {
    it('should contain system-reminder and completion marker', async () => {
      // Given a completing task
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(client, makeTaskInfo())

      // Then the text contains required literals
      const text = client.promptCalls[0].text
      expect(text).toContain('<system-reminder>')
      expect(text).toContain('[COPILOT DELEGATION COMPLETED]')
      expect(text).toContain('</system-reminder>')
    })

    it('should include task ID, status, and copilot_output hint', async () => {
      // Given a completing task with specific ID
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(client, makeTaskInfo({ taskId: 'cpl_abc-def' }))

      // Then text includes task ID and output hint
      const text = client.promptCalls[0].text
      expect(text).toContain('cpl_abc-def')
      expect(text).toContain('copilot_output')
    })

    it('should show agent and model as default when not specified', async () => {
      // Given a task with no agent or model
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(client, makeTaskInfo())

      // Then agent and model show as "default"
      const text = client.promptCalls[0].text
      expect(text).toContain('default')
    })

    it('should include ACTION REQUIRED on failed status', async () => {
      // Given a failed task
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified with failed status
      await notifyCompletion(
        client,
        makeTaskInfo({ status: 'failed', exitCode: 1 }),
      )

      // Then text includes action required
      const text = client.promptCalls[0].text
      expect(text).toContain('ACTION REQUIRED')
      expect(text).toContain('1')
    })

    it('should send prompt to the correct parent session ID', async () => {
      // Given a task for session B
      const client = mockClient()
      incrementInFlight('session-B')

      // When notified
      await notifyCompletion(
        client,
        makeTaskInfo({ parentSessionID: 'session-B' }),
      )

      // Then prompt is sent to session B
      expect(client.promptCalls[0].sessionId).toBe('session-B')
    })
  })

  describe('TUI toast', () => {
    it('should fire a toast on successful completion', async () => {
      // Given a completing task
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(client, makeTaskInfo())

      // Then toast is fired with success variant
      expect(client.toastCalls).toHaveLength(1)
      expect(client.toastCalls[0].variant).toBe('success')
    })

    it('should fire toast with error variant on failure', async () => {
      // Given a failed task
      const client = mockClient()
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(
        client,
        makeTaskInfo({ status: 'failed', exitCode: 1 }),
      )

      // Then toast is fired with error variant
      expect(client.toastCalls[0].variant).toBe('error')
    })
  })

  describe('cancelled status', () => {
    it('should set noReply false for cancelled tasks', async () => {
      const client = mockClient()
      incrementInFlight('session-A')
      incrementInFlight('session-A')

      await notifyCompletion(client, makeTaskInfo({ status: 'cancelled' }))

      expect(client.promptCalls[0].noReply).toBe(false)
    })

    it('should show error toast variant for cancelled tasks', async () => {
      const client = mockClient()
      incrementInFlight('session-A')

      await notifyCompletion(client, makeTaskInfo({ status: 'cancelled' }))

      expect(client.toastCalls[0].variant).toBe('error')
      expect(client.toastCalls[0].message).toContain('cancelled')
    })
  })

  describe('error handling', () => {
    it('should not throw when prompt call fails', async () => {
      // Given a client whose prompt throws
      const client = mockClient()
      client.session.prompt = async () => {
        throw new Error('session expired')
      }
      incrementInFlight('session-A')

      // When notified — should not throw
      await expect(
        notifyCompletion(client, makeTaskInfo()),
      ).resolves.toBeUndefined()
    })

    it('should call app.log with structured body shape when prompt fails', async () => {
      // Given a client whose prompt throws
      const client = mockClient()
      client.session.prompt = async () => {
        throw new Error('session expired')
      }
      incrementInFlight('session-A')

      // When notified
      await notifyCompletion(client, makeTaskInfo({ taskId: 'cpl_log-test' }))

      // Then app.log is called with a structured body object, not positional args
      expect(client.logCalls).toHaveLength(1)
      const logArg = client.logCalls[0]
      expect(typeof logArg).toBe('object')
      expect(logArg).not.toBeNull()
      const arg = logArg as {
        body: { service: string; level: string; message: string }
      }
      expect(arg.body.service).toBe('copilot-delegate')
      expect(arg.body.level).toBe('warn')
      expect(arg.body.message).toContain('cpl_log-test')
    })
  })
})
