import { describe, expect, it } from 'bun:test'

type CancelTaskById = (
  taskRegistry: {
    getTask: (taskId: string) =>
      | {
          abortController: AbortController
          status: string
        }
      | undefined
  },
  taskId: string,
) => { cancelled: boolean; error?: string }

async function loadCancelTaskById(): Promise<CancelTaskById> {
  const module = await import('../src/runtime/cancel-helper.ts')
  const cancelTaskById = Reflect.get(module, 'cancelTaskById')

  expect(typeof cancelTaskById).toBe('function')

  return cancelTaskById as CancelTaskById
}

describe('cancel helper', () => {
  it('returns no such task when the task is missing', async () => {
    const cancelTaskById = await loadCancelTaskById()

    const result = cancelTaskById(
      {
        getTask: () => undefined,
      },
      'cpl_missing',
    )

    expect(result).toEqual({ cancelled: false, error: 'no such task' })
  })

  it('aborts a running task exactly once and returns cancelled', async () => {
    const cancelTaskById = await loadCancelTaskById()
    const abortController = new AbortController()
    let abortCount = 0

    abortController.signal.addEventListener('abort', () => {
      abortCount += 1
    })

    const result = cancelTaskById(
      {
        getTask: (taskId) => {
          expect(taskId).toBe('cpl_running')

          return {
            abortController,
            status: 'running',
          }
        },
      },
      'cpl_running',
    )

    expect(result).toEqual({ cancelled: true })
    expect(abortController.signal.aborted).toBe(true)
    expect(abortCount).toBe(1)
  })

  it('stays idempotent enough for repeated cancels on the same task', async () => {
    const cancelTaskById = await loadCancelTaskById()
    const abortController = new AbortController()
    let abortCount = 0

    abortController.signal.addEventListener('abort', () => {
      abortCount += 1
    })

    const taskRegistry = {
      getTask: () => ({
        abortController,
        status: 'running',
      }),
    }

    const first = cancelTaskById(taskRegistry, 'cpl_running')
    const second = cancelTaskById(taskRegistry, 'cpl_running')

    expect(first).toEqual({ cancelled: true })
    expect(second).toEqual({ cancelled: true })
    expect(abortCount).toBe(1)
  })
})
