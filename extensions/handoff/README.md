# @maphew/handoff

Exact-state engineering handoffs for [swamp](https://github.com/swamp-club/swamp).

A handoff is the durable record a successor agent reads to resume work without
replaying chat history: exact Git state, authoritative Bead state, and the
outgoing agent's narrative — goal, scope, decisions, the next safe step, and the
operations that must not be performed. This extension makes that record a
first-class swamp behavior: **the capture is mechanical and testable, the
narrative is agent-authored, and the tracker stays authoritative.**

It is the native replacement for a standalone `capture_state.py` script: instead
of printing JSON to a terminal, `capture` writes a queryable `handoff` resource
and a markdown report that survive the session.

## Requirements

- The `git` CLI must be available (or point the `gitCommand` global arg at it).
- The `bd` CLI is optional. When it is present and the target directory has a
  `.beads/` database, the active Bead's status, assignee, owner, and blocking
  dependencies are captured. When it is absent, the Git half is still captured
  and the report records that Bead metadata was unavailable.

The extension does not read or call `@maphew/bd`; it shells out to `git` and
`bd` directly, exactly as `@maphew/bd` does, so it has no cross-extension
dependency and works in any Git checkout.

## Install

```bash
swamp extension pull @maphew/handoff
swamp behavior create @maphew/handoff handoff
```

## Methods

| Method    | Purpose                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `capture` | Snapshot Git + Bead state with the handoff narrative; write resource + report |
| `resume`  | Read the newest handoff for a Bead and write a cold-start resume brief  |
| `list`    | Catalogue the handoffs stored on this behavior instance                 |

### `capture`

```bash
swamp behavior run handoff capture \
  --input beadId=myswamp-imx \
  --input baseRef=origin/main \
  --input goal="Land the native handoff extension" \
  --input nextSafe="swamp extension quality extensions/handoff/manifest.yaml --json" \
  --input 'forbidden=["git push --force"]'
```

Arguments:

| Arg            | Required | Description                                                        |
| -------------- | -------- | ------------------------------------------------------------------ |
| `beadId`       | yes      | Active Bead identifier                                             |
| `baseRef`      | no       | Ref to diff against; resolved to a SHA and a merge-base            |
| `goal`         | no       | Accepted goal for this work                                        |
| `scope`        | no       | Scope still in play                                                |
| `completed`    | no       | Completed scope items                                              |
| `excluded`     | no       | Scope explicitly excluded                                          |
| `commands`     | no       | Commands run with exact outcomes (`succeeded`/`failed`/`not-run`) |
| `evidence`     | no       | Locations of test/review evidence                                  |
| `decisions`    | no       | Decisions already made                                             |
| `openQuestions`| no       | Open hypotheses and owner decisions outstanding                    |
| `nextSafe`     | no       | The single next safe command or action                             |
| `forbidden`    | no       | Operations explicitly not to perform                               |
| `notes`        | no       | Any other durable context                                          |

Writes the `handoff` resource (instance `handoff-<beadId>`) and a markdown
artifact under `report-handoff-<beadId>`.

### `resume`

```bash
swamp behavior run handoff resume --input beadId=myswamp-imx
```

Reads the newest `handoff-<beadId>` and writes a `resume` resource plus a
one-screen brief that leads with the next safe step and the forbidden
operations, followed by the full stored handoff.

### `list`

```bash
swamp behavior run handoff list --input limit=20
```

Writes a `catalog` resource with one row per stored handoff (data name, version,
capture time, Bead, branch, HEAD).

## Retrieve the artifacts

```bash
# Structured handoff record
swamp data query 'modelName == "handoff" && name == "handoff-myswamp-imx"' \
  --select content --single

# Rendered markdown report (path to the stored artifact)
swamp data get handoff report-handoff-myswamp-imx

# Cold-start resume brief
swamp data get handoff report-resume-handoff-myswamp-imx
```

## Global arguments

| Arg          | Default | Description                                                 |
| ------------ | ------- | ----------------------------------------------------------- |
| `repoDir`    | `.`     | Worktree to capture (portable across machines/worktrees)    |
| `gitCommand` | `git`   | Git executable                                              |
| `bdCommand`  | `bd`    | Beads executable                                            |
| `bdDir`      | `.`     | Working directory for `bd` (auto-discovers `.beads/`)       |

## What is (and is not) captured

Captured: worktree and repo roots, shared `.git` dir, credential-redacted
origin, branch, HEAD SHA, optional base SHA and merge-base, upstream ref and
ahead/behind counts, staged/unstaged/untracked/conflicted paths, in-progress
`merge`/`rebase`/`cherry-pick`/`revert`/`am`, and the Bead's id/title/status/
assignee/owner/blocking dependencies.

Not captured: credentials (remote userinfo and query strings are redacted),
secret values, or an unbounded command log. Command outcomes are only what the
caller supplies via `commands`.

## License

MIT. See [LICENSE](./LICENSE).
