---
title: Biome markdown formatting corrupted docs frontmatter and failed the changesets release PR
date: 2026-11-21
category: build-errors
module: docs_tooling
problem_type: build_error
component: tooling
symptoms:
  - "systematic_search indexed none of the docs/solutions files because their frontmatter no longer parsed"
  - "Bun.YAML.parse threw Multiline implicit key where root_cause, severity and tags had been indented under a list"
  - "Biome inserted a blank line after the opening --- and after list keys such as symptoms and applies_when"
  - "Lint failed on changeset-release/main (release PR #565) after changeset version regenerated CHANGELOG.md"
root_cause: config_error
resolution_type: config_change
severity: medium
related_components:
  - documentation
  - development_workflow
tags: [biome, markdown-formatter, yaml-frontmatter, renovate, changesets, changelog, systematic-search]
---

# Biome markdown formatting corrupted docs frontmatter and failed the changesets release PR

## Problem
Biome 2.6 formats markdown, and `biome.json` formatted every `**` path. `.github/renovate.json5` runs `postUpgradeTasks: { commands: ['bun install', 'bun run fix', 'bun run build'] }`. So the Renovate Biome bumps #492 (2.6.2, 2026-11-01) and #516 (2.6.5, 2026-11-07) rewrote YAML frontmatter as markdown and merged as routine dependency PRs. For about three weeks no `docs/solutions/` doc was searchable. Separately, the generated `CHANGELOG.md` failed lint on the release branch.

## Symptoms
- #492 turned this valid frontmatter in `docs/solutions/ui-bugs/re-entrant-dialog-close-froze-copilot-status-on-escape-2026-05-02.md`:
  ```yaml
  symptoms:
    - Layout and input rewrites changed the presentation but did not remove the freeze.
  root_cause: wrong_api
  ```
  into this, which fails `Bun.YAML.parse` with `Multiline implicit key`:
  ```yaml
  ---

  - Layout and input rewrites changed the presentation but did not remove the freeze.
    root_cause: wrong_api
  ```
  The list items lost their indentation, and the top-level keys after them were indented as list continuations.
- #516 added a blank line after `symptoms:` and `applies_when:`, and one before the closing `---`.
- In `docs/solutions/developer-experience/opencode-debug-diagnostics-2026-04-26.md`, the list item `- "build · model" stalls without progress, …` is a quoted scalar followed by more text, which YAML cannot parse.
- The release PR's lint failed (run 44814746882): `changeset version` writes `CHANGELOG.md` with blank lines inside nested list items, which Biome rejects.

## What Didn't Work
- **Removing only the blank line after the opening `---`.** #564 did this in 21 docs and turned off the docs formatter. Every `docs/solutions/` doc still failed to parse because of the indented keys.
- **Linting `CHANGELOG.md` on `main`.** The copy on `main` passes because it was formatted earlier. The failure only appears on `changeset-release/main`, after regeneration.

## Solution
`biome.json` now excludes generated and frontmatter-bearing markdown from formatting. `!CHANGELOG.md` came from #566 and the `overrides` block from #564:

```json
"files": {
  "includes": ["**", "!dist", "!node_modules", "!.changeset", "!.context", "!CHANGELOG.md"]
},
"overrides": [
  { "includes": ["docs/**/*.md"], "formatter": { "enabled": false } }
]
```

#588 repaired the frontmatter of the 10 existing docs; bodies are unchanged:
- moved the indented keys back to column 0 (`root_cause`, `resolution_type`, `severity`, `related_components`, `tags`);
- deleted the blank lines;
- wrapped the problem item in single quotes: `- '"build · model" stalls without progress, or `assistant[]` comes back empty'`.

Validation used for the repair:

```sh
bun -e 'for await (const f of new Bun.Glob("docs/**/*.md").scan(".")) {
  const t = await Bun.file(f).text(); if (!t.startsWith("---\n")) continue
  try { Bun.YAML.parse(t.match(/^---\n([\s\S]*?)\n---\n/)[1]) } catch (e) { console.log(f, e.message) }
}'
```

## Why This Works
From the diffs, Biome treats the frontmatter block as markdown body text: it removes list indentation and treats the following lines as continuations. The formatter has no frontmatter-aware mode here, so the only safe setting is not to format those files. `CHANGELOG.md` belongs to changesets, so it is excluded from Biome entirely rather than reformatted after every `changeset version`.

## Prevention
- Keep frontmatter-bearing markdown out of Biome's formatter. `.changeset/` is already excluded entirely, and `docs/**/*.md` keeps lint but loses formatting.
- `bun run fix` runs inside Renovate's `postUpgradeTasks`. Review any Biome bump that touches files beyond `package.json` and `bun.lock` as a content change.
- Run the `Bun.YAML.parse` check above after editing docs. On its own this is a manual step, and nothing ran it when #492 landed.
- This PR also adds a `Bun.YAML.parse` frontmatter check for every `docs/**/*.md` to the test suite, so a formatter or hand edit that breaks frontmatter now fails CI instead of silently dropping docs from search.
- Exclude generated artifacts (`CHANGELOG.md`) from formatters instead of reformatting what a tool will regenerate.

## Related Issues
- PRs #492, #516 (cause), #564, #566, #588 (fixes), release PR #565, run 44814746882
