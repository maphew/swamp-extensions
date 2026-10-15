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
  --input task="Implement the thing described in myswamp-xcy"
```

Every dispatch exports a distinct `BEADS_ACTOR` (`<agent>-<branch>`) so
concurrent runs — and the interactive session that launched them — cannot
silently double-claim a bead. A failed agent exit is recorded in the `dispatch`
resource and then raised so the calling workflow step fails.

### `sweep`

Fan-out over a manifest's candidates. One method call holds one behavior lock
for the whole sweep, instead of one lock per issue, and iterations are
serialized on purpose because `dispatch` force-resets its checkout.

```bash
swamp behavior run agent-task sweep \
  --input 'candidates:json=[{"id":"myswamp-xcy", ...}]'
```

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
```

For concurrent ad-hoc dispatches, give each run its own `behaviorName` (the
auto-created definition holds the lock for the whole agent run).

## Retrieve the artifacts

```bash
swamp data query 'modelName == "agent-task-queue" && name == "manifest"' \
  --select content --single

swamp data query 'modelName == "agent-task-queue" && name == "sweep"' \
  --select content --single
```

## License

MIT. See [LICENSE](./LICENSE).
