# @maphew/agent-task

Headless agent dispatch for [swamp](https://github.com/swamp-club/swamp).

This extension replaces a shell dispatch cluster that used to live in a swamp
repo's `.kilo/agents/` directory:

| Retired script    | Behavior method       |
| ----------------- | --------------------- |
| `ready-queue.sh`  | `filterQueue`         |
| `run-task.sh`     | `dispatch`            |
| `bd-sweep.sh`     | `sweep`               |

Each used to wrap a CLI (`bd`, `git`, and the agent binaries) behind
`command/shell`. Now the queue cut, the branch preflight, and the fan-out are
typed behavior operations with resources, reports, and unit-testable helpers.

## Requirements

- `git` on `PATH` (or point `gitCommand` at it).
- `bd` on `PATH` for `filterQueue`, in a directory with a `.beads/` database
  (or point `bdCommand`/`bdDir` at it).
- At least one supported headless agent binary: `claude`, `codex`, `opencode`,
  or `kilo`.

`git` and `bd` are subprocess dependencies, exactly as in `@maphew/bd` and
`@maphew/handoff`; there is no cross-behavior `runModel` dependency.

## Install

```bash
swamp extension pull @maphew/agent-task
```

## Methods

| Method        | Purpose                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `filterQueue` | Filter `bd ready` into a typed `manifest` of dispatch candidates        |
| `dispatch`    | Branch a target checkout and run one agent on one task                  |
| `sweep`       | Dispatch every candidate from a manifest, serially, under one lock      |
| `run`         | Run one headless agent on a prompt in a checkout — no git, no plan      |
| `sandboxes`   | List sandbox worktrees with dirty state, commits ahead, and PR state    |
| `pruneSandboxes` | Remove clean merged/closed sandboxes (dry-run by default)            |

### `run`

`run` is the **runner primitive**: the one authority on how a headless agent is
launched. It builds the agent's invocation, exports `BEADS_ACTOR` and trace
context, runs it, and captures stdout, stderr and the exit code. It does no
branching and writes nothing to the target repo.

Other extensions call it through `runModel` (declaring `@maphew/agent-task`
under `dependencies`) when they want an agent but own their own git workflow —
`@maphew/pr-sweep` does exactly that for its review batches, so there is one
launch path instead of a copy per extension.

```bash
swamp model method run agent-task-queue run \
  --input workdir="/path/to/checkout" \
  --input prompt="Do the thing" \
  --input systemPrompt="You are working in /path/to/checkout"
```

Pass `model` (provider/model, e.g. `zai-coding-plan/glm-5.3`) to override the
agent's configured default for that run. Empty is the default and adds no model
flag. The flag is `-m` for `kilo`, `opencode`, and `codex`; `--model` for
`claude`. For kilo it is placed before the `--` prompt separator.

```bash
swamp model method run agent-task-queue run \
  --input workdir="/path/to/checkout" \
  --input prompt="Do the thing" \
  --input model="kilo/kilo-auto/efficient"
```

### `filterQueue`

Reads `bd ready --json`, drops issues a human must unblock (`waiting-on-user`,
`blocked`, `needs-human`, `wontfix`, `duplicate`), drops spikes and issues with
open dependencies, then maps each remaining issue to a checkout by longest
issue-id prefix. Issues with no mapping are recorded in the manifest (not
silently dispatched), and an issue already covered by a local or remote
`bd/<id>` branch is dropped with the reason.

```bash
swamp behavior run agent-task filterQueue \
  --input 'workdirMap={"myswamp":"/srv/myswamp","swamp-extensions":"/srv/swamp-extensions"}' \
  --input maxItems=2
```

`filterQueue` also accepts `model`; each candidate carries it so a manifest
round-trip does not lose the intended model. The same `model` can be passed to
`dispatch` and `sweep` (sweep uses it only for candidates that do not carry
their own).

It writes:

- `manifest` — the candidates plus the dropped and unmapped dispositions.
- a `report` file — a markdown rendering of the same.

### `dispatch`

Preflights the target checkout (is a git repo, has `origin`, is clean, branch
does not already exist locally or on `origin`), fetches `origin`, resets the
base branch, creates the feature branch, and runs the agent inside the target
repo so it loads that repo's own `AGENTS.md`. The agent is expected to commit,
push, and open a PR.

```bash
swamp behavior run agent-task dispatch \
  --input workdir=/srv/kilo-cloud \
  --input branch=bd/myswamp-xcy \
  --input task="Implement the thing described in myswamp-xcy" \
  --input model="zai-coding-plan/glm-5.3"
```

Every dispatch exports a distinct `BEADS_ACTOR` (`<agent>-<branch>`) so
concurrent runs — and the interactive session that launched them — cannot
silently double-claim a bead. A failed agent exit is recorded in the `dispatch`
resource and then raised so the calling workflow step fails.

### Sandboxes: let `dispatch`/`sweep` mint the checkout

Pass `sandboxRoot` and the agent runs in a fresh `git worktree` instead of the
mapped checkout:

```bash
swamp behavior run agent-task dispatch \
  --input workdir=/srv/myswamp \
  --input branch=bd/myswamp-xcy \
  --input task="Implement the thing" \
  --input sandboxRoot=/srv/.worktrees \
  --input issueId=myswamp-xcy
```

The worktree is created as
`<sandboxRoot>/<repo>-<id>` from `origin/<base>` and removed after a **successful**
run. A failed run is always kept for inspection, and `keepSandbox=true` keeps a
successful one too. The `dispatch` resource records the path in `sandbox`.

`workdirMap` still maps an issue-id prefix to the **source** checkout; the
sandbox path is derived, so N issues in one repo need one checkout, not N.

Worktrees share the source repo's object database and show up in
`git worktree list`, which is why they are preferred over `git clone` for
isolation.

### `sandboxes` and `pruneSandboxes`

`sandboxes` is read-only: it lists each worktree under `sandboxRoot` with its
branch, source checkout, dirty state, commits ahead of the base, whether HEAD is
already merged, and the PR state when `gh` can answer.

`pruneSandboxes` removes only **clean** sandboxes whose branch is merged into the
base or whose PR is closed/merged, then runs `git worktree prune`. It is a dry
run by default; pass `dryRun=false` to act.

```bash
swamp behavior run agent-task sandboxes --input sandboxRoot=/srv/.worktrees
swamp behavior run agent-task pruneSandboxes --input sandboxRoot=/srv/.worktrees
swamp behavior run agent-task pruneSandboxes \
  --input sandboxRoot=/srv/.worktrees --input dryRun=false
```

### `sweep`

Fan-out over a manifest's candidates. One method call holds one behavior lock
for the whole sweep, instead of one lock per issue, and iterations are
serialized on purpose because `dispatch` force-resets its checkout.

```bash
swamp behavior run agent-task sweep \
  --input 'candidates:json=[{"id":"myswamp-xcy", ...}]'
```

Pass `model` to give every candidate that does not specify one a model; a
candidate's own `model` always wins.

It writes a `dispatch` resource per candidate, a `sweep` summary resource, and
a `report` file.

## Wiring it from a workflow

```yaml
- name: filter-queue
  task:
    type: behavior
    behaviorType: "@maphew/agent-task"
    behaviorName: agent-task-queue
    methodName: filterQueue
    inputs:
      workdirMap: ${{ inputs.workdirMap }}
      maxItems: ${{ inputs.maxItems }}

- name: run-agents
  dependsOn: [{ step: filter-queue, condition: { type: succeeded } }]
  task:
    type: behavior
    behaviorType: "@maphew/agent-task"
    behaviorName: agent-task-queue
    methodName: sweep
    inputs:
      candidates: ${{ data.latest("agent-task-queue", "manifest").attributes.candidates }}
      sandboxRoot: ${{ inputs.sandboxRoot }}
      keepSandbox: ${{ inputs.keepSandbox }}
```

For concurrent ad-hoc dispatches, give each run its own `behaviorName` (the
auto-created definition holds the lock for the whole agent run).

## Retrieve the artifacts

```bash
swamp data query 'modelName == "agent-task-queue" && name == "manifest"' \
  --select content --single

swamp data query 'modelName == "agent-task-queue" && name == "sweep"' \
  --select content --single

swamp data query 'modelName == "agent-task-queue" && name == "sandboxes-current"' \
  --select content --single
```

## License

MIT. See [LICENSE](./LICENSE).
