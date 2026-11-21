// Small helpers for run-host.sh, so the shell script never parses JSON.
// Usage: node util.mjs <command> [args]. Exit status is the answer.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_TOOLS = [
  'copilot_cancel',
  'copilot_delegate',
  'copilot_output',
  'copilot_resume',
]
const PLUGIN_ID = 'opencode-copilot-delegate'

const here = dirname(fileURLToPath(import.meta.url))
const [command, ...args] = process.argv.slice(2)

const readStdin = () => readFileSync(0, 'utf8')

const commands = {
  // pin <id>: print "<host> <package> <version>" from the pins file.
  pin() {
    const file = join(here, '..', '..', 'scripts', 'opencode-host-pins.json')
    const { pins } = JSON.parse(readFileSync(file, 'utf8'))
    const pin = pins.find((candidate) => candidate.id === args[0])
    if (!pin) {
      console.error(`unknown pin: ${args[0]}; known: ${pins.map((p) => p.id)}`)
      process.exit(2)
    }
    console.log(`${pin.host} ${pin.package} ${pin.version}`)
  },

  // port: print a free TCP port on loopback.
  async port() {
    const server = createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    console.log(server.address().port)
    server.close()
  },

  // copilot-tools: stdin is a JSON array of tool ids (V1) or of copilot ids
  // (V2 observer file); exit 0 only when exactly the four copilot_* tools
  // are present.
  'copilot-tools'() {
    let ids
    try {
      ids = JSON.parse(readStdin())
    } catch {
      process.exit(1)
    }
    if (!Array.isArray(ids)) process.exit(1)
    const found = ids.filter((id) => id.startsWith('copilot_')).sort()
    if (found.join(',') !== EXPECTED_TOOLS.join(',')) {
      console.error(`copilot_* tools: [${found.join(', ')}]`)
      process.exit(1)
    }
  },

  // plugin-active: stdin is the V2 GET /api/plugin response,
  // `{ location, data: [{ id, state: { status } }] }`. `data` is [] for a few
  // seconds after the location is created. Exit 0 only when this plugin
  // reports active.
  'plugin-active'() {
    let body
    try {
      body = JSON.parse(readStdin())
    } catch {
      process.exit(1)
    }
    const plugins = Array.isArray(body?.data) ? body.data : []
    const entry = plugins.find((plugin) => plugin.id === PLUGIN_ID)
    if (entry?.state?.status !== 'active') {
      console.error(`plugin state: ${JSON.stringify(entry ?? null)}`)
      process.exit(1)
    }
  },
}

const run = commands[command]
if (!run) {
  console.error(`unknown command: ${command}`)
  process.exit(2)
}
await run()
