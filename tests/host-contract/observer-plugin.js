// V2-only observer plugin. V2 has no HTTP route that lists tools, so this
// plugin asks the host for its tool list and writes the copilot_* ids to
// $HOST_CONTRACT_TOOLS_FILE. run-host.sh installs it as
// <project>/.opencode/plugin/zz-observer/index.js; the zz- prefix orders it
// after the plugin under test.
import { writeFile } from 'node:fs/promises'

const MAX_POLLS = 120
const POLL_MS = 500

export default {
  id: 'host-contract-observer',
  async setup(ctx) {
    const out = process.env.HOST_CONTRACT_TOOLS_FILE
    let stopped = false

    const poll = async () => {
      for (let i = 0; i < MAX_POLLS && !stopped; i++) {
        try {
          await ctx.tool.reload()
          const ids = (await ctx.tool.list())
            .map((tool) => tool.id)
            .filter((id) => id.startsWith('copilot_'))
            .sort()
          await writeFile(out, `${JSON.stringify(ids)}\n`)
        } catch (error) {
          await writeFile(`${out}.err`, `${error}\n`).catch(() => {})
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      }
    }
    void poll()

    return async () => {
      stopped = true
    }
  },
}
