// Tool-execution proof with no model. run-host.sh copies this file next to the
// clean install's node_modules and runs it there, so the bare import below
// resolves through the installed package's `exports` map, as a host would.
//
// Usage: node drive.mjs <v1|v2> <workspace-dir>
//
// It calls the entry the host would call (V1 `server()` with a V1-shaped
// input, V2 `setup()` with a fake V2 context), delegates a task, waits for
// completion, and reads the envelope back. The `copilot` on PATH must be the
// replay shim in tests/fixtures/bin.
import { execFileSync } from 'node:child_process'
import * as entry from 'opencode-copilot-delegate'

const plugin = entry.default
const [mode, directory] = process.argv.slice(2)
const EXPECTED_TOOLS = [
  'copilot_cancel',
  'copilot_delegate',
  'copilot_output',
  'copilot_resume',
]
const SESSION_ID = 'ses_host_contract'

const fail = (message) => {
  console.error(`FAIL (${mode}): ${message}`)
  process.exit(1)
}

// A hung host seam must fail the leg, not hang CI.
setTimeout(() => fail('timed out after 60s'), 60_000).unref()

if ((mode !== 'v1' && mode !== 'v2') || !directory) {
  console.error('usage: node drive.mjs <v1|v2> <workspace-dir>')
  process.exit(2)
}

// A V1 host runs every named export as a plugin factory, so the entry must
// export only `default`.
if (Object.keys(entry).join(',') !== 'default') {
  fail(`entry has named exports: ${Object.keys(entry)}`)
}
if (
  Object.keys(plugin).sort().join(',') !== 'id,server,setup' ||
  plugin.id !== 'opencode-copilot-delegate'
) {
  fail(`unexpected default export shape: ${Object.keys(plugin)}`)
}

const copilotOnPath = execFileSync('sh', ['-c', 'command -v copilot'], {
  encoding: 'utf8',
}).trim()
if (!copilotOnPath.endsWith('/tests/fixtures/bin/copilot')) {
  fail(`copilot on PATH is not the replay shim: ${copilotOnPath}`)
}

// Each host adapter yields `call(name, args) -> envelope text`, plus the
// notices the plugin sent to the host, plus a cleanup.
async function startV1() {
  const notices = []
  const hooks = await plugin.server({
    client: {
      app: { log: async () => {} },
      session: {
        prompt: async (request) => {
          notices.push(request)
        },
      },
    },
    directory,
    worktree: directory,
  })
  const abort = new AbortController().signal
  return {
    names: Object.keys(hooks.tool ?? {}),
    notices,
    call: async (name, args) => {
      const result = await hooks.tool[name].execute(args, {
        sessionID: SESSION_ID,
        messageID: 'msg_host_contract',
        agent: 'build',
        directory,
        worktree: directory,
        abort,
        metadata: () => {},
        ask: async () => {},
      })
      return typeof result === 'string' ? result : result.output
    },
    cleanup: async () => {},
  }
}

async function startV2() {
  const notices = []
  const added = []
  const cleanup = await plugin.setup({
    location: { directory },
    session: {
      synthetic: async (request) => {
        notices.push(request)
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (tool) => added.push(tool) })
        return { dispose: async () => {} }
      },
      reload: async () => {},
      list: async () => added.map((tool) => ({ ...tool, id: tool.name })),
    },
  })
  if (typeof cleanup !== 'function') fail('setup() returned no cleanup')
  const signal = new AbortController().signal
  return {
    names: added.map((tool) => tool.name),
    notices,
    call: async (name, args) => {
      const tool = added.find((candidate) => candidate.name === name)
      // V2 validates input with the tool's own Standard Schema before execute.
      const parsed = await tool.input['~standard'].validate(args)
      if (parsed.issues)
        fail(`${name} input rejected: ${JSON.stringify(parsed.issues)}`)
      const result = await tool.execute(parsed.value, {
        sessionID: SESSION_ID,
        messageID: 'msg_host_contract',
        agent: 'build',
        id: 'call_host_contract',
        progress: async () => {},
        signal,
      })
      return result.content
    },
    cleanup,
  }
}

const host = await (mode === 'v1' ? startV1() : startV2())

if (host.names.slice().sort().join(',') !== EXPECTED_TOOLS.join(',')) {
  fail(`registered tools: ${host.names}`)
}

const delegated = JSON.parse(
  await host.call('copilot_delegate', { prompt: 'host-contract replay' }),
)
if (
  typeof delegated.task_id !== 'string' ||
  !delegated.task_id.startsWith('cpl_')
) {
  fail(
    `copilot_delegate did not return a task_id: ${JSON.stringify(delegated)}`,
  )
}

// block waits for completion, up to 30s.
const envelope = JSON.parse(
  await host.call('copilot_output', {
    task_id: delegated.task_id,
    block: true,
    timeout_ms: 30_000,
  }),
)
if (envelope.status !== 'complete') {
  fail(
    `status ${envelope.status}, expected complete: ${JSON.stringify(envelope)}`,
  )
}
if (envelope.exit_code !== 0) fail(`exit_code ${envelope.exit_code}`)
if (
  typeof envelope.final_message !== 'string' ||
  envelope.final_message === ''
) {
  fail(`final_message is ${JSON.stringify(envelope.final_message)}`)
}
if (envelope.timed_out) fail('copilot_output timed out')

// The completion notice goes out asynchronously after the process closes.
for (let i = 0; i < 50 && host.notices.length === 0; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100))
}
if (host.notices.length === 0) fail('no completion notice reached the host')

await host.cleanup()
console.log(
  `OK (${mode}): ${delegated.task_id} complete, exit_code=0, ` +
    `final_message=${envelope.final_message.length} chars, ` +
    `notices=${host.notices.length}`,
)
process.exit(0)
