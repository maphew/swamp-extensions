# @maphew/pr-sweep

Sweep the open pull requests a fork contributes to an upstream GitHub
repository. A single `sweep` method lists the fork's open PRs, hands them to a
headless agent with an adversarial-review prompt, then re-fetches each base
branch and brings behind branches up to date before recording a verdict per PR.

The companion [`@maphew/pr-sweep-config`](../pr-sweep-config/) extension stores
the repository pairs (upstream + fork) that a sweep-all workflow iterates.

## Requirements

- `git` and the [`gh`](https://cli.github.com/) CLI on `PATH`, authenticated for
  the upstream repo and the fork.
- A local checkout of the upstream repo with an `origin` pointing at the fork
  and a remote (usually `upstream`) pointing at the upstream repo.
- A headless agent binary on `PATH`. `kilo` is the default; `claude`, `codex`,
  and `opencode` are also supported.
- GitHub permissions to push to the fork and merge in the upstream (a
  fork-maintainer workflow). The sweep never pushes to a protected branch.

## Install

```bash
swamp extension pull @maphew/pr-sweep
swamp model create @maphew/pr-sweep pr-sweep
```

## Methods

The sweep is **composable**. Each step reads its inputs from written data, so
steps chain without wiring anything between them, and an orchestrator (Ceph, a
foreman agent, a workflow, or you) decides how work groups and when it runs.

| Method     | Purpose                                                                    |
| ---------- | -------------------------------------------------------------------------- |
| `list`     | Open fork PRs -> the queue (`open-prs-current` + one `pr` record each), and the review batches that queue suggests |
| `review`   | One headless agent over **one batch** of PRs; records each verdict, state and sync outcome |
| `sync`     | Deterministic branch sync + bounded verify/top-up. No agent                |
| `verdicts` | Read the recorded per-PR results back as data                              |
| `summary`  | Tally results into the `sweep` summary resource and a markdown report      |
| `sweep`    | Convenience: `list` -> one `review` batch over every PR -> `summary`       |

```bash
# One call, as before
swamp model method run pr-sweep sweep \
  --input upstreamRepo="Kilo-Org/kilocode" \
  --input forkRepo="maphew/kilocode" \
  --input workdir="/path/to/kilocode"

# Or compose: list the queue, then review one batch of two
swamp model method run pr-sweep list --input workdir="/path/to/kilocode"
swamp model method run pr-sweep review --input numbers='[7040,7041]'
swamp model method run pr-sweep sync
swamp model method run pr-sweep summary
```

### Who decides what

The behavior does the work; the caller decides the shape of it.

- **Batching.** `list` takes `batchSize` and reports how the queue groups
  (`batches`), but never splits work on its own. One agent for one PR, one
  agent for ten — the orchestrator's call.
- **Sync timing.** `review` syncs its own batch by default (`resyncBehind`);
  turn it off to sync later, or call `sync` separately.
- **Delegation.** Each `review` call _is_ one worker. A foreman that wants
  three agents running makes three `review` calls, one per batch.

The agent itself is launched by `@maphew/agent-task`'s `run` method — pr-sweep
owns the prompt and the batch, not the invocation.

## Arguments

| Argument         | Default  | Description                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------- |
| `upstreamRepo`   | —        | Upstream GitHub repo as `owner/name` (**required**)                                          |
| `forkRepo`       | —        | Fork GitHub repo as `owner/name` (**required**)                                              |
| `workdir`        | —        | Local checkout of the upstream repo (**required**)                                           |
| `agent`          | `kilo`   | Headless agent to run the sweep (`claude`, `codex`, `opencode`, `kilo`)                      |
| `mainBranch`     | `main`   | Base branch to rebase and merge into                                                         |
| `resyncBehind`   | `true`   | `review` only: bring the batch's behind branches up to date after the agent run               |
| `numbers`        | all      | `review` / `sync` only: the PR numbers this call covers                                       |
| `batchSize`      | `0`      | `list` only: group the queue into review batches of at most n (0 = one batch)                 |
| `updateStrategy` | `merge`  | How to update a behind branch: merge the base in (no force-push) or rebase (force-push)      |
| `sweeperPrompt`  | —        | Absolute path to a custom sweeper prompt (overrides the bundled prompt)                      |
| `swampRepoDir`   | —        | Legacy fallback: if set and `<dir>/.kilo/agents/pr-sweeper.md` exists, it overrides the prompt |

The sweeper prompt is bundled with the extension
(`prompts/pr-sweeper.md`), so no repo-local prompt file is required. An explicit
`sweeperPrompt` path, or a legacy repo-local `.kilo/agents/pr-sweeper.md`, wins
when present.

## Output

- `summary-current` — run summary: counts, timestamp, and the agent's prose report
- `<upstream>-<number>` per-PR resources — `verdict`, `merged`, `state`,
  `syncStatus`, and `syncDetail`

```bash
swamp data query 'modelName == "pr-sweep" && name == "summary-current"' --select content
```

## How a sweep works

1. `gh pr list --limit 1000` lists open PRs whose head repository is the fork.
2. The agent runs in the upstream checkout with the bundled sweeper prompt. As
   each PR finishes, the agent appends one `PR #<n>: <action>` line to a durable
   file; a truncated closing message can no longer lose verdicts. stdout is the
   fallback.
3. Each PR's post-run state is read (`gh pr view`).
4. If `resyncBehind` is set, a base-move pass re-fetches each PR's base branch
   and brings behind branches up to date in a throwaway worktree (the operator's
   checkout is never touched), then a per-PR verification pass re-checks PRs the
   first pass left current so a mid-sweep base move is caught.
5. Per-PR and summary resources are written.

## License

MIT. See [LICENSE](./LICENSE).
