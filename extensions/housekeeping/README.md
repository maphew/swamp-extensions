# @maphew/housekeeping

Generic, portable **housekeeping sweep** for [swamp](https://github.com/swamp-club/swamp).

Say "run housekeeping" in any checkout and get one structured audit of the
cruft that accumulates around a working copy: dirty trees, diverged or deleted
branches, forgotten stashes, stale worktrees, temp debris, leftover processes,
disk pressure, and stuck tracker claims — then act on the findings with
judgment. The posture is **notice and report; delete only the obviously dead**.

The type is project-agnostic. `projectDir` defaults to `.`, so the same model
works in any git repository. Beads (`.beads/`) and swamp (`.swamp/`) awareness
is layered on only when those directories exist.

## Why this exists

A recurring manual routine — "run daily report and housekeeping" — was being
re-derived by an agent from `AGENTS.md` in each repo, with the exact steps
drifting per project. This model captures the *generic* half of that routine as
one typed, diffable, schedulable artifact. What is left for the agent is the
part that needs judgment: interpreting the findings and answering *"what did I
notice that isn't on any list?"*.

## Install

```bash
swamp extension pull @maphew/housekeeping
swamp model create @maphew/housekeeping housekeeping
```

The bundled `@maphew/housekeeping` workflow requires an instance named
`housekeeping`; create it in each project you want to sweep. Only
`projectDir` needs setting when you want to audit a path other than `.`.

## Usage

```bash
# Read-only audit — writes audit/git/worktrees/temp/beads resources + report
swamp model method run housekeeping check

# Or through the bundled workflow
swamp workflow run housekeeping
```

Read the report:

```bash
swamp data query 'modelName == "housekeeping" && name == "report-current"' \
  --select content --single
swamp data query 'modelName == "housekeeping" && name == "audit-current"' \
  --select content --json
```

### Cleanup methods — dry-run by default

Every mutation defaults to `dryRun=true`. Inspect the candidate list, then
re-run with `dryRun=false`.

```bash
# Remove worktree entries whose path no longer exists on disk
swamp model method run housekeeping pruneWorktrees --input dryRun=false

# Release tracker claims whose lease expired / went idle
swamp model method run housekeeping unclaimStaleBeads
swamp model method run housekeeping unclaimStaleBeads --input dryRun=false
# add --input force=true to release another actor's claim

# Delete matched temp debris older than staleTempHours
swamp model method run housekeeping cleanTemp
swamp model method run housekeeping cleanTemp --input dryRun=false --input force=true
```

`unclaimStaleBeads` deliberately does **not** force by default: bd only lets the
current assignee release its own claim, and letting an expired lease reclaim
work is usually safer than clobbering a live session.

## What it checks

| Category    | Checks                                                                 |
| ----------- | ---------------------------------------------------------------------- |
| `git`       | detached HEAD, dirty/untracked tree, branch behind/deleted upstream, gone branches, stashes, local branches already merged into the mainline |
| `worktrees` | path missing on disk (stale), git-marked prunable, locked, detached    |
| `temp`      | configured globs under `$TMPDIR` + project root, age + size, stale marker |
| `process`   | leftover processes matching `processPatterns` (default `dolt sql-server`) |
| `disk`      | free space below 2 GiB on the project filesystem                       |
| `beads`     | `bd` version vs `.beads/.local_version`, expired/idle in-progress claims, `bd stale`, `bd orphans`, `bd doctor --check=artifacts\|pollution\|conventions` |

## Configuration

Global arguments (per model instance):

| Argument          | Default                              | Purpose                                             |
| ----------------- | ------------------------------------ | --------------------------------------------------- |
| `projectDir`      | `.`                                  | Repository root to audit                            |
| `defaultBranch`   | auto (`origin/HEAD`, then `main`)    | Mainline used for merged-branch detection           |
| `bdBin`           | `bd`                                 | Beads binary name or path                           |
| `staleClaimDays`  | `7`                                  | Idle age after which a claim is reported stale      |
| `staleTempHours`  | `24`                                 | Age after which matched temp debris is stale        |
| `tempGlobs`       | `beads-bd-tests-*`, `*.tmp`, `*.swp`, `*.orig`, `*.rej` | One-level globs matched under the temp roots |
| `tempRoots`       | `[]` → `$TMPDIR` + `projectDir`      | Directories scanned for temp debris                 |
| `processPatterns` | `["dolt sql-server"]`                | `pgrep -af` patterns; empty disables                |
| `includeBeads`    | `true`                               | Tracker checks when `.beads/` is present            |
| `includeTemp`     | `true`                               | Temp / process / disk checks                        |

## Relationship to specialist extensions

This is the **aggregator**. It reports the generic surface and does not try to
replace deeper, domain-specific tools — compose them in a workflow instead:

| Need                                             | Extension                          |
| ------------------------------------------------ | ---------------------------------- |
| Deep worktree diagnosis + prune                  | `@mgreten/git-worktree-doctor`     |
| Swamp-repo portability (hardcoded paths, pulled-extension integrity, `.gitignore`) | `@maphew/repo-doctor`              |
| Docker disk reclamation                          | `@sntxrr/docker-reclaim`           |
| "What is eating my disk?"                        | `@svendowideit/disk-auditor`       |

Wire them into the same workflow where installed:

```yaml
# a project's local workflow
jobs:
  - name: housekeeping
    steps:
      - name: sweep
        task: { type: model_method, modelIdOrName: housekeeping, methodName: check }
      - name: repo
        task: { type: model_method, modelIdOrName: repo-doctor, methodName: scan }
        dependsOn: [{ step: sweep, condition: { type: succeeded } }]
      - name: worktrees
        task: { type: model_method, modelIdOrName: worktree-doctor, methodName: diagnose }
        dependsOn: [{ step: sweep, condition: { type: always } }]
```

## Scheduling it

The bundled workflow has no trigger so installing the extension never starts
background work. To run the read-only audit nightly, add a trigger to a copy of
the workflow in the project, or run the model method from an existing scheduler.
The audit performs no writes outside swamp's own data store and the generated
report.

## For agents

When a user says "run housekeeping", run the workflow (or `check` method), read
`report-current`, act only on unambiguous findings, and answer the closing
question in the report before finishing:

> **What did I notice that isn't on any list?**

Anything ambiguous goes into a tracker issue or a handoff — never the trash.

## Development

```bash
~/.swamp/deno/deno check extensions/housekeeping/src/housekeeping.ts
~/.swamp/deno/deno test --allow-read --allow-write --allow-run --allow-env \
  extensions/housekeeping/src/housekeeping_test.ts
```
