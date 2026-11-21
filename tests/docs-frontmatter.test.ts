import { describe, expect, test } from 'bun:test'

// systematic_search skips any doc whose YAML frontmatter does not parse.
// Biome's markdown formatter once corrupted every docs/solutions file this way
// (docs/solutions/build-errors/biome-markdown-formatter-corrupts-frontmatter-and-changelog-2026-11-21.md),
// so the suite checks that every docs/**/*.md frontmatter block still parses.

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/

const docs: { path: string; frontmatter: string }[] = []
for await (const path of new Bun.Glob('docs/**/*.md').scan('.')) {
  const text = await Bun.file(path).text()
  if (!text.startsWith('---\n')) continue
  const match = text.match(FRONTMATTER)
  docs.push({ path, frontmatter: match?.[1] ?? '' })
}

describe('docs frontmatter', () => {
  test('finds documents to check', () => {
    expect(docs.length).toBeGreaterThan(0)
  })

  test('rejects the corruption Biome produced (keys indented under a list)', () => {
    const corrupted = [
      'title: Example',
      'symptoms:',
      '',
      '- first symptom',
      '  root_cause: wrong_api',
    ].join('\n')
    expect(() => Bun.YAML.parse(corrupted)).toThrow()
  })

  test.each(docs.map((doc) => [doc.path, doc] as const))(
    '%s has parseable YAML frontmatter',
    (_path, doc) => {
      expect(doc.frontmatter).not.toBe('')
      // A missing closing fence would let the lazy match run into the body up
      // to a later `---` rule; a markdown heading inside the block exposes that.
      expect(doc.frontmatter).not.toMatch(/^#{1,6} /m)
      const parsed = Bun.YAML.parse(doc.frontmatter) as Record<string, unknown>
      expect(typeof parsed).toBe('object')
    },
  )

  test.each(
    docs
      .filter((doc) => doc.path.startsWith('docs/solutions/'))
      .map((doc) => [doc.path, doc] as const),
  )('%s carries the core solution fields', (_path, doc) => {
    const parsed = Bun.YAML.parse(doc.frontmatter) as Record<string, unknown>
    for (const key of ['title', 'date', 'category', 'problem_type']) {
      expect(parsed[key], `${key} in ${doc.path}`).toBeDefined()
    }
  })
})
