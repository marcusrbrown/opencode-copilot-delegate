---
title: "Use a version-scoped Bun override key to fix a deep transitive advisory"
date: 2026-11-21
category: best-practices
module: dependency_management
problem_type: tooling_decision
component: dependencies
severity: medium
applies_when:
  - "A bun audit advisory affects one major line of a package that also resolves at other majors in the tree"
  - "The vulnerable copy sits more than one parent level below a direct dependency"
  - "Choosing an overrides key in the root package.json under Bun 1.4.x"
tags: [bun, overrides, bun-audit, transitive-dependencies, brace-expansion, lockfile, security-advisory]
---

# Use a version-scoped Bun override key to fix a deep transitive advisory

## Context
PR #568 had to raise `brace-expansion` to `>=2.1.8` to clear GHSA-6j4f-fj2g-mc7p, GHSA-qhr7-859c-m2p7 and GHSA-q2hr-2g5m-vwhr. The vulnerable 2.1.4 copy sat four levels deep: `@opentui/solid > babel-plugin-module-resolver > glob > minimatch > brace-expansion`. Another `brace-expansion` copy, 5.0.12 under `rimraf`, was not affected and had to stay where it was. PR #568 tried four override forms against a freshly regenerated lockfile with Bun 1.4.5:

| Override key | Result |
| --- | --- |
| nested `babel-plugin-module-resolver → glob → minimatch → brace-expansion` | ignored (stays 2.1.4) |
| `"minimatch@8.0.7": { "brace-expansion": ... }` | works, but is tied to one exact minimatch version |
| global `"brace-expansion": "^2.1.8"` | works, but forces rimraf's 5.x copy down to 2.x |
| `"brace-expansion@2": "^2.1.8"` | chosen |

## Guidance
- **Prefer a version-scoped key, `"<pkg>@<selector>": "<fixed range>"`.** It matches every dependent whose *declared* range overlaps the selector, wherever that dependent sits in the tree. Other majors are left alone.
- **Don't write a path deeper than one parent.** Bun supports only one parent level. Its docs say it ignores `a>b>c`, `a/b/c` and deeper object nesting with a warning. That is why the nested form did nothing.
- **Don't use a bare global key when the package resolves at more than one major.** `"brace-expansion": "^2.1.8"` rewrites every copy, including the unaffected 5.x one.
- **Avoid parent-with-version keys such as `"minimatch@8.0.7"`.** They break silently as soon as the parent is bumped.
- **Verify with the resolver, not the manifest.** Run `bun why <pkg>` and check that each major is where you expect it. Then run `bun audit` and confirm the advisory entry is gone.
- **Expect a lockfile format bump.** Bun writes a lockfile that contains nested or version-scoped rules as `lockfileVersion` 3, which older Bun versions cannot read. PR #568 moved `bun.lock` from 2 to 3. CI pins `bun = "1.4.5"` in `mise.toml`.

## Why This Matters
A path-based override that Bun ignores leaves the advisory open, and it looks like a fix in the diff. A global override silently downgrades an unrelated major and can break the package that needs it. The version-scoped key targets exactly the vulnerable line and nothing else. It also keeps working as the tree changes. After #582 and #587 added the V2 host's dev dependencies, a second 2.x path appeared (`gaxios > rimraf@5.0.10 > glob@10.5.0 > minimatch@9.0.9`), and the same key covered it with no edit.

## When to Apply
- `bun audit` flags a transitive package and the fixed version is in the same major as the vulnerable one.
- The package resolves at several majors and only one is vulnerable.
- Review the key again when the vulnerable path moves. Since #587 moved `@opentui/*` and `solid-js` to devDependencies plus optional peers, this path is dev-only. Under the SECURITY section of `.github/workflows/fro-bot.yaml`, it is now classed DEV-ONLY (disposition `monitor`), not SHIPPED.

## Examples
`package.json` on main:

```json
"overrides": {
  "@opentui/core": "0.8.4",
  "zod": "^4.6.7",
  "brace-expansion@2": "^2.1.8"
}
```

`bun.lock` stores the same rule in object form:

```json
"brace-expansion@2": {
  ".": "^2.1.8",
},
```

`bun why brace-expansion@2.1.8` on main shows both 2.x paths raised, while `brace-expansion@5.0.12` stays under `minimatch@10.2.5`:

```text
brace-expansion@2.1.8
  ├─ minimatch@8.0.7 (requires ^2.0.1)
  │  └─ glob@9.3.5 … babel-plugin-module-resolver@5.0.2 … @opentui/solid@0.8.4
  └─ minimatch@9.0.9 (requires ^2.0.2)
     └─ glob@10.5.0 … rimraf@5.0.10 … gaxios@7.1.3
```

`bun audit`:
- In PR #568: 11 findings before (6 high, 4 moderate, 1 low) and 8 after (4 high, 3 moderate, 1 low), with no `brace-expansion` entry left.
- Now 7 on main (4 high, 3 moderate).

## Related
- PR #568 (the override), PR #587 (moved `@opentui/*` to dev and optional peers), PR #589 (adds a Renovate hold on `@opentui/*`)
- Bun docs, "Overrides and resolutions": the Nested overrides, Version-scoped overrides and Limitations sections
- `.github/workflows/fro-bot.yaml`, the SECURITY section's SHIPPED vs DEV-ONLY rules
