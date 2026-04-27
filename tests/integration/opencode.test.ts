import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const PLUGIN_DIST = join(REPO_ROOT, 'dist', 'index.js')

const OPENCODE_AVAILABLE = (() => {
  const r = spawnSync('which', ['opencode'])
  return r.status === 0
})()

const HAS_LLM_AUTH = Boolean(process.env.COPILOT_PAT ?? process.env.GH_TOKEN)

const OPENCODE_TEST_MODEL =
  process.env.OPENCODE_TEST_MODEL ?? 'opencode/minimax-m2.5'

const TEST_TIMEOUT_MS = 90_000

interface OpencodeResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Throw a rich error if the subprocess did not exit cleanly, so a CI failure
 * surfaces the subprocess's stderr tail instead of just `expected 0, got X`.
 * Stderr is truncated to 2 KB so a flooded child does not overwhelm the log.
 */
function assertOk(result: OpencodeResult): void {
  if (result.exitCode === 0) return
  const stderr = result.stderr.slice(-2000) || '(empty)'
  throw new Error(
    `opencode exited with non-zero status\n` +
      `exitCode=${result.exitCode}\n` +
      `stderr (last 2000 chars):\n${stderr}`,
  )
}

interface RunOptions {
  cwd: string
  configDir: string
}

/**
 * Spawn `opencode run` in non-interactive mode against an isolated config dir.
 *
 * Isolation strategy:
 *   - `OPENCODE_CONFIG_DIR` points at an empty per-test temp dir, so OpenCode does not
 *     read the developer's `~/.config/opencode/opencode.json`. This keeps user-installed
 *     plugins (Magic Context, OMO, etc.) out of test sessions; without it, throwaway
 *     test sessions would load every globally-configured plugin and burn cycles
 *     producing artifacts no one wants.
 *   - `OPENCODE_CONFIG_CONTENT` declares this repo's built `dist/index.js` as a
 *     `file://` plugin so the three tools under test are registered in the test session.
 *   - `OPENCODE_DISABLE_*` flags cut out first-boot work paths irrelevant to these tests
 *     (LSP downloads, model registry refresh, prune, autoupdate).
 *
 * Auth:
 *   - The opencode/* free models hit `https://opencode.ai/zen` rate limits (HTTP 429)
 *     under repeated runs and silently retry until tests time out. The default model
 *     `opencode/minimax-m2.5` is paid and reliable; override with `OPENCODE_TEST_MODEL`.
 *   - `COPILOT_PAT` (or `GH_TOKEN`) is forwarded to the subprocess as `GH_TOKEN` so the
 *     `copilot_delegate` tool can authenticate the underlying `copilot` CLI.
 */
function runOpencode(prompt: string, options: RunOptions): OpencodeResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_CONFIG_DIR: options.configDir,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      plugin: [`file://${PLUGIN_DIST}`],
    }),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PRUNE: 'true',
  }
  const copilotToken = process.env.COPILOT_PAT ?? process.env.GH_TOKEN
  if (copilotToken) env.GH_TOKEN = copilotToken

  // spawnSync blocks the test runner for the duration of the call. Worst-case
  // hang is bounded by `timeout`: when it elapses, Node sends SIGTERM and reaps
  // the child, after which spawnSync returns with `signal: 'SIGTERM'` and a
  // null status. Sequential test execution means the suite's worst-case wall
  // clock is roughly `TEST_TIMEOUT_MS * scenario_count`.
  const result = spawnSync(
    'opencode',
    ['run', '--model', OPENCODE_TEST_MODEL, prompt],
    {
      cwd: options.cwd,
      env,
      timeout: TEST_TIMEOUT_MS,
      encoding: 'utf8',
      // OpenCode without `--print-logs` writes a small footer to stderr; with
      // it, stderr can exceed the default 1 MB and trip ENOBUFS, killing the
      // child via SIGTERM. We size for headroom in case `OPENCODE_LOG_LEVEL` or
      // similar is exported in the parent env.
      maxBuffer: 64 * 1024 * 1024,
    },
  )

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  }
}

interface Fixture {
  rootDir: string
  projectDir: string
  configDir: string
}

function makeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'copilot-delegate-int-'))
  const projectDir = join(rootDir, 'project')
  const configDir = join(rootDir, 'config')
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  // A trivial package.json keeps `opencode run` from probing the parent dir tree
  // for project context, which would otherwise re-discover this repo's own files.
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'integration-test-fixture', private: true }),
  )
  return { rootDir, projectDir, configDir }
}

describe.skipIf(!OPENCODE_AVAILABLE)('opencode integration', () => {
  let fixture: Fixture

  beforeEach(() => {
    if (!existsSync(PLUGIN_DIST)) {
      throw new Error(
        `Plugin dist not found at ${PLUGIN_DIST}. Run \`bun run build\` first.`,
      )
    }
    fixture = makeFixture()
  })

  afterEach(() => {
    if (fixture) rmSync(fixture.rootDir, { recursive: true, force: true })
  })

  describe.skipIf(!HAS_LLM_AUTH)('LLM-driven scenarios', () => {
    test(
      'copilot_delegate returns a task_id matching cpl_*',
      () => {
        const result = runOpencode(
          'Use the copilot_delegate tool with the prompt "say hi" and report ' +
            'the exact task_id you receive verbatim in your reply.',
          { cwd: fixture.projectDir, configDir: fixture.configDir },
        )
        assertOk(result)
        expect(result.stdout).toMatch(/cpl_[0-9a-f-]+/)
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'copilot_output reports status: unknown for nonexistent task_id',
      () => {
        const result = runOpencode(
          'Use the copilot_output tool with task_id "cpl_does_not_exist" and ' +
            'tell me the value of the status field in the response.',
          { cwd: fixture.projectDir, configDir: fixture.configDir },
        )
        assertOk(result)
        expect(result.stdout.toLowerCase()).toContain('unknown')
      },
      TEST_TIMEOUT_MS,
    )

    test(
      'copilot_cancel cancels a running delegation',
      () => {
        const result = runOpencode(
          'First call copilot_delegate with prompt "wait 30 seconds then say done". ' +
            'Then immediately call copilot_cancel with the task_id you just received. ' +
            'Tell me the value of the cancelled field in the cancel response.',
          { cwd: fixture.projectDir, configDir: fixture.configDir },
        )
        assertOk(result)
        // Require both the keyword "cancel" and the literal "true" to appear so
        // a chatty model that volunteers the word "true" without actually
        // calling the cancel tool can't pass.
        const out = result.stdout.toLowerCase()
        expect(out).toMatch(/cancel(led|ed)/)
        expect(out).toContain('true')
      },
      TEST_TIMEOUT_MS,
    )
  })
})
