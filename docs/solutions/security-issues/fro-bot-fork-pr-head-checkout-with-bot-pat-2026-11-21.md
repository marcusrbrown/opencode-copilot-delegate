---
title: Comment-triggered Fro Bot runs checked out fork PR heads on a runner holding FRO_BOT_PAT
date: 2026-11-21
category: security-issues
module: fro_bot_workflow
problem_type: security_issue
component: infrastructure
symptoms:
  - "A trusted @fro-bot comment on a fork PR checked out refs/pull/N/head and ran bun install on it"
  - "The job-level fork guard never fired for issue_comment, whose payload has no github.event.pull_request"
  - "An @fro-bot mention in an issue body started a run whatever the author_association"
  - Nothing deterministic stopped a Fro Bot APPROVED review on a PR it had committed to or that Marcus did not own
root_cause: missing_validation
resolution_type: workflow_improvement
severity: high
related_components:
  - authentication
tags: [fro-bot, github-actions, pwn-request, fork-pr, issue-comment, author-association, approval-backstop]
---

# Comment-triggered Fro Bot runs checked out fork PR heads on a runner holding FRO_BOT_PAT

## Problem
This was a pwn-request hole in `.github/workflows/fro-bot.yaml`. An `@fro-bot` comment on a PR fires `issue_comment`. That payload has no `github.event.pull_request`, so the job-level fork guard passed. The checkout then took `refs/pull/N/head`, which can be a fork. `bun install` ran that head's `package.json` lifecycle scripts on the runner whose next step, `fro-bot/agent`, receives `secrets.FRO_BOT_PAT`.

## Symptoms
- Before #555, the checkout `ref` for any comment on a PR was `format('refs/pull/{0}/head', github.event.issue.number)`, and nothing checked the head repo.
- The `issues` trigger needed only `contains(github.event.issue.body || '', '@fro-bot')`, with no author check.
- The "may approve" rule existed only as prompt text, and comment-triggered runs get no prompt at all.

## What Didn't Work
- **The job-level fork guard.** `!github.event.pull_request.head.repo.fork` protects `pull_request` and `pull_request_review_comment`. For `issue_comment`, `github.event.pull_request == null` short-circuits it to true.
- **Gating the commenter.** The comment branch already required `author_association` OWNER, MEMBER or COLLABORATOR. That checks who asked, not whose code gets checked out. One trusted mention on a hostile fork PR was enough.
- **`persist-credentials: false`.** It keeps the PAT out of `.git/config`. But install scripts run on the same runner before the agent step that holds the PAT, so they can tamper with the workspace or tooling that step then executes.

## Solution
In PR #555, a `prehead` step resolves the PR head for comment triggers and refuses heads from other repositories:

```yaml
- name: Resolve same-repo PR head for comment triggers
  id: prehead
  if: github.event_name == 'issue_comment' && github.event.issue.pull_request
  run: |
    set -euo pipefail
    pr_json=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}")
    head_repo=$(printf '%s' "$pr_json" | jq -r '.head.repo.full_name // empty')
    if [ "$head_repo" != "$REPO" ]; then
      echo "::error::Refusing to check out a PR head from another repository (PR #${PR_NUMBER}, head=${head_repo:-unknown})."
      exit 1
    fi
    echo "sha=$(printf '%s' "$pr_json" | jq -r '.head.sha')" >> "$GITHUB_OUTPUT"
```

The checkout uses `steps.prehead.outputs.sha || github.event.pull_request.head.sha || ''`, and the same SHA is passed to the agent as `trusted-head-sha`.

The trigger gates were tightened:
- The `issues` branch adds `contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.issue.author_association || '')`.
- Comments from `[bot]` logins are ignored.
- `review_requested` fires only when `fro-bot` is the reviewer requested.
- Prompt category 3 (REACTIVE ISSUE HEALING) acts only on issues opened, or labelled `bug`, by OWNER, MEMBER or COLLABORATOR. Everything else is report-only.

Approvals now have a deterministic backstop:
- The `approval-rule` step's `decide()` allows approval only when the PR author is `marcusrbrown` and no commit's author or committer login is `fro-bot`. Any `gh` failure returns `allowed=false`, so it fails closed.
- The `approval-backstop` job (`permissions: {}`, fresh runner, no checkout) runs `always()` when the main job was not skipped and `needs.fro-bot.outputs.allowed != 'true'`. It dismisses every `fro-bot` `APPROVED` review, and fails if listing reviews or any dismissal fails.

## Why This Works
- **Head repo looked up, not inferred.** The head repo comes from the API instead of a payload field that doesn't exist for this event, so a fork head is never checked out. Checkout and agent use the SHA from that same response, which leaves no gap between checking the head and checking it out.
- **Prompt rule enforced after the fact.** The backstop doesn't trust the agent. It runs where nothing the agent job left behind can reach the step holding the PAT.

## Prevention
- For every trigger, ask what code gets checked out and whether secrets are on the runner. A payload without `pull_request` needs an explicit head-repo lookup before checkout.
- Gate on the code's origin, not only the requester's role.
- Back every prompt-level permission rule (approve, merge, push) with a deterministic job that undoes violations.
- Keep the prompt's WORKFLOW INTEGRITY audit (category 8): "no path runs fork-controlled code (checkout or `bun install` of a fork head) with secrets present."

## Related Issues
- PR #555 (review fixes in 9937e0b)
- Delivery-mode fix from the same PR: `docs/solutions/integration-issues/fro-bot-autoheal-fixes-discarded-without-output-mode-2026-11-21.md`
