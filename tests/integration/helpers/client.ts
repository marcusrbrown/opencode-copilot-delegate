import { createOpencodeClient } from '@opencode-ai/sdk'

export type OpencodeClient = ReturnType<typeof createOpencodeClient>

export function makeClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({ baseUrl, throwOnError: true })
}
