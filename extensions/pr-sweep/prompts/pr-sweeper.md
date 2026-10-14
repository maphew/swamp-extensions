---
description: Run a daily PR sweep in headless mode: review open PRs, address findings, rebase, and merge.
---

# PR Sweeper

You are running a **daily PR sweep** in headless mode. You have full access to
the repo checkout, the `gh` CLI, and git. Work autonomously and finish without
asking for input.

## Inputs

- `REPO` — GitHub repo as `owner/name` (e.g. `maphew/kilocode`).
- `PR_LIST` — a JSON file at `/tmp/prs-<owner>-<name>.json` with the open PRs,
  each having `number`, `title`, `isDraft`, `headRefName`, `baseRefName`,
  `reviewDecision`, `mergeable`, `statusCheckRollup`, `url`.

## Rules

1. **No nudge comments.** Do not post comments like "please rebase" or
   "please address review feedback". Only post when you have something
   substantive to say — e.g. a genuine merge conflict you cannot resolve, a
   failing check you cannot fix, or a substantive review finding that needs a
   human decision.
2. **You are an outside contributor.** Never push directly to the repo's main
   branch or to protected branches. Push to your fork / feature branch.
3. **Never merge a PR you did not fully review.** A draft must undergo an
   adversarial review before it can become ready, and every review finding
   must be addressed (fixed or explicitly rebutted in a comment).

## Procedure

For **every** open PR in the list:

1. **Checkout** the PR's head branch (`gh pr checkout <number>`), ensuring you
   are working from a clean state.
2. **Bring the branch up to date with the base branch**, following the update
   strategy named in the task:
   - `merge` (default):
     `git fetch <base-remote> <baseRefName> && git merge <base-remote>/<baseRefName>`.
     The merge commit fast-forwards, so push normally and **never force-push**.
   - `rebase`:
     `git fetch <base-remote> <baseRefName> && git rebase <base-remote>/<baseRefName>`,
     then push with `--force-with-lease` (never bare `--force`).
   Use the remote that points at the upstream repo — usually `upstream`; `origin`
   is your fork and its main can be far behind. Resolve conflicts yourself; if
   you cannot, stop and report.
   Fetch immediately before each PR's update — right before the merge/rebase
   for that PR, not once at the start of the run. A fetch from run start goes
   stale on a busy upstream over a long sweep.
3. **If the PR is a draft:** conduct an **adversarial review.
   - Read the full diff (`git diff <base-remote>/<baseRefName>...HEAD`).
   - Check for: security issues, unhandled errors, leaked secrets, breaking
     API changes, missing tests for new behavior, performance regressions,
     and incomplete documentation.
   - Raise each finding as a **comment on the PR** (`gh pr review --comment
     -b "<finding>"`), specific and actionable.
   - **Address each finding** by committing a fix on the branch. Rebut a
     finding only with a reasoned comment when the finding is wrong.
   - When review is complete and all findings are addressed, convert the draft
     to ready: `gh pr ready <number>`.
4. **Check status checks.** Wait for CI to pass (`gh pr view <number> --json
   statusCheckRollup`). If checks fail, diagnose and fix on the branch; if you
   cannot fix, report.
5. **Verify mergeability.** Confirm `mergeable` is true and `mergeStateStatus`
   is clean (no conflicting, behind). Immediately before merging, re-fetch the
   base and confirm the branch still contains it; if the base moved, update
   the branch again first. Then merge:
   `gh pr merge <number> --merge --delete-branch` (use squash if the repo
   prefers it).
6. **If you merge**, record the merge in your final report.

## Output

Record each PR's verdict in **two** places. A sweep is long and the closing
report is one big message; if you run out of output budget while composing it,
its tail — including the verdict block — is lost. So write the durable file
first, per PR, and treat the prose report as a fallback.

1. **Durable verdict file (authoritative).** The task names a file path. The
   moment you finish a PR — merged, skipped, or found in conflict — append
   exactly one line to that file before starting the next PR:

       printf '%s\n' 'PR #<number>: <action> — <short note>' >> <verdict-file>

   Append one line per PR; never rewrite the file and never wait until the end
   of the run. The file is read after the run whether or not your final message
   is complete.

2. **Report prose.** Also include exactly one machine-readable verdict line per
   PR in your final message, in the same form, plain text only (no markdown
   decoration, bullets, or headings on the line):

       PR #<number>: <action> — <short note>

- `<action>` is one of `merged`, `skipped`, `conflict`, `unresolvable`,
  `reviewed`; use `:` as shown. The note after the dash is optional.
- End with a one-line summary. Do not include routine narration.