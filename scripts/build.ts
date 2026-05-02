import solidTransformPlugin from '@opentui/solid/bun-plugin'

async function build(options: Parameters<typeof Bun.build>[0]): Promise<void> {
  const result = await Bun.build(options)

  if (result.success) return

  for (const log of result.logs) {
    console.error(log)
  }

  throw new Error(`Failed to build ${options.entrypoints.join(', ')}`)
}

await build({
  entrypoints: ['src/index.ts'],
  outdir: 'dist',
  target: 'bun',
  external: ['@opencode-ai/plugin'],
})

await build({
  entrypoints: ['src/tui/index.tsx'],
  outdir: 'dist/tui',
  target: 'bun',
  external: [
    '@opencode-ai/plugin',
    '@opencode-ai/plugin/tui',
    '@opentui/core',
    '@opentui/solid',
    'solid-js',
  ],
  plugins: [solidTransformPlugin],
})
