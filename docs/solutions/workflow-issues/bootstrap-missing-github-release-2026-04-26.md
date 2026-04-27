---
title: Missing GitHub Release for already-published npm package
date: 2026-04-26
category: workflow-issues
module: release_pipeline
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - Bootstrapping the first release of a new npm package using changesets/action and Trusted Publishing
  - A version is manually published to npm before changesets/action runs for that version
  - Auditing a release pipeline that skipped a version's GitHub Release or git tag
tags:
  - changesets-action
  - github-release
  - npm-publish
  - trusted-publishing
  - workflow-run
  - release-pipeline
---

# Missing GitHub Release for already-published npm package

## Context

When bootstrapping a new npm package that uses `changesets/action` for automated publishing and GitHub Release creation, a chicken-and-egg problem arises with npm Trusted Publishing. Trusted Publishing requires the package to already exist in the npm registry before you can register a trusted publisher (via OIDC), so the very first publish must be done manually with `npm publish --access=public`.

`changesets/action` only creates GitHub Releases and pushes git tags for packages it actually publishes during its `changeset publish` step. If the version has already been manually published, `changeset publish` correctly detects this and skips publishing — and consequently `changesets/action` skips creating both the GitHub Release and the tag, leaving a gap where the version exists on npm but the corresponding GitHub artifacts that users and tools rely on for visibility and automation are missing.

## Guidance

For the first release of a new npm package using changesets and Trusted Publishing, follow this bootstrap sequence to avoid the gap:

1. Manually publish the initial version to npm: `npm publish --access=public`.
2. Register npm Trusted Publishing for the package (this requires the package to exist first).
3. In the repository, manually create and push a git tag for the version, then create the GitHub Release using the `CHANGELOG.md` content.

Subsequent releases (v0.1.1, v0.2.0, etc.) flow fully through `changesets/action` since Trusted Publishing is now configured.

If the gap has already occurred (a version was manually published before `changesets/action` ran), backfill the missing tag and Release as follows:

```sh
# Tag the commit that bumped the version (typically the version-packages PR's merge commit)
git tag -a v0.1.0 <commit-sha> -m "v0.1.0"
git push origin v0.1.0

# Create GitHub Release with the matching CHANGELOG.md section as body
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "$(awk '/^## 0\.1\.0/{flag=1; next} /^## /{flag=0} flag' CHANGELOG.md)" \
  --verify-tag
```

When `gh release create` hits a GraphQL rate limit, fall back to the REST endpoint (which uses a different quota):

```sh
NOTES=$(awk '/^## 0\.1\.0/{flag=1; next} /^## /{flag=0} flag' CHANGELOG.md)
gh api -X POST /repos/<org>/<repo>/releases \
  -f tag_name=v0.1.0 -f name=v0.1.0 \
  -f body="$NOTES" -F draft=false -F prerelease=false
```

## Why This Matters

GitHub Releases are the primary notification channel for users following a repository. Without one, watchers and "Releases only" subscribers never see the new version, and downstream automation that polls the GitHub API for releases silently drops the version.

The git tag is the authoritative link between the published package and the exact code state. It backs `npm view <pkg> repository` deep links, `git describe`, Renovate's release matching, GitHub's "compare" UI, and any tooling that maps SemVer versions to commits. A version on npm without a matching tag is effectively detached from its source history.

The `CHANGELOG.md` entry rendered in the Release body is also the only release-notes surface for non-npm consumers — without it, the only way to learn what changed in the version is to read the raw `CHANGELOG.md` on `main`.

## When to Apply

- Bootstrapping the first release of a new npm package that integrates `changesets/action` with npm Trusted Publishing.
- Any time a package version is manually published to npm before `changesets/action` executes its publish step for that version.
- During audits of a release pipeline where a version exists on npm but the matching git tag or GitHub Release is missing.

## Examples

### Recommended bootstrap sequence (first release)

After setting up changesets and merging the version-packages PR that bumps `package.json` to your initial version (e.g., `0.1.0`):

```sh
# 1. Manually publish to npm. The Release workflow's later run will safely no-op
#    on the publish step.
npm publish --access=public

# 2. Register Trusted Publisher at https://www.npmjs.com/package/<pkg>/access
#    Workflow filename must be the exact file (e.g., `release.yaml`, with extension).

# 3. Backfill the tag + Release for this bootstrap version
git tag -a v0.1.0 <version-packages-merge-sha> -m "v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "$(awk '/^## 0\.1\.0/{flag=1; next} /^## /{flag=0} flag' CHANGELOG.md)" \
  --verify-tag
```

### Backfill for an already-published version with no Release

The `opencode-copilot-delegate` v0.1.0 case. The version was manually published to npm; the Release workflow ran and emitted:

```
🦋 warn opencode-copilot-delegate is not being published because version 0.1.0 is already published on npm
🦋 warn No unpublished projects to publish
```

Resulting in:

```
$ git tag -l 'v*'
(empty)
$ gh release list
(empty)
```

Backfill (commit SHA `06dec48` was the version-packages PR merge commit):

```sh
git tag -a v0.1.0 06dec48 -m "v0.1.0"
git push origin v0.1.0
gh api -X POST /repos/marcusrbrown/opencode-copilot-delegate/releases \
  -f tag_name=v0.1.0 -f name=v0.1.0 \
  -f body="$(awk '/^## 0\.1\.0/{flag=1; next} /^## /{flag=0} flag' CHANGELOG.md)" \
  -F draft=false -F prerelease=false
```

After:

```
$ git tag -l 'v*'
v0.1.0
$ gh release list
TITLE   TYPE    TAG NAME  PUBLISHED
v0.1.0  Latest  v0.1.0    about 1 minute ago
```

## Related

- Release workflow: `.github/workflows/release.yaml`
- `changesets/action` source for `createGithubReleases` behavior: it derives Releases from the `publishedPackages` array returned by `changeset publish`.
- npm Trusted Publishing docs: https://docs.npmjs.com/trusted-publishers
- The case that prompted this learning: https://github.com/marcusrbrown/opencode-copilot-delegate/actions/runs/24973154347/job/73120421936
