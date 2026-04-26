---
'opencode-copilot-delegate': minor
---

Add automated release pipeline. A new `Release` workflow runs after the `CI` workflow succeeds on `main`, opens a "Version Packages" pull request via `changesets/action` when changesets are pending, and publishes to npm via OIDC trusted publishing once that PR merges. Adds `@changesets/cli` as a development dependency and the `version-changesets` and `publish-changesets` scripts to drive the version-bump and publish steps.
