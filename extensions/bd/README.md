# @maphew/bd

Beads (`bd`) issue tracker bridge for [swamp](https://github.com/swamp-club/swamp).
Exposes a local [beads](https://github.com/gastownhall/beads) database as a swamp
model type (`@maphew/bd`) so workflows, reports, and CEL expressions can read and
write project issues like any other resource.

## Requirements

- The `bd` CLI must be installed and on `PATH` (or point the `bdCommand` global
  arg at it).
- A `.beads/` database must exist in the target project directory (`bd init`
  creates one).

## Install

```bash
swamp extension pull @maphew/bd
swamp model create @maphew/bd my-tracker
```

## Methods

| Method   | Purpose                                                        |
| -------- | -------------------------------------------------------------- |
| `list`   | List issues with optional status/type/assignee filters         |
| `query`  | Filter issues with bd's query language (`status=open AND type=bug`) |
| `ready`  | List issues ready to work (no active blockers)                 |
| `show`   | Show one issue by ID                                           |
| `create` | Create an issue (title, type, priority, labels, parent, ...)   |
| `update` | Edit fields, relabel, or atomically claim (`claim: true`)      |
| `close`  | Close an issue, optionally with a reason; preserves its fields |
| `reopen` | Reopen one or more closed issues, optionally with a reason     |
| `dep`    | Manage dependencies: `add`/`remove`/`list` for an issue        |
| `reclaim`| Revert stale in_progress issues to open (dead-worker recovery) |
| `graph`  | Dependency graph as structured nodes, typed edges, and layers  |
| `prime`  | Capture bd prime workflow context and git-authority policy     |
| `note`   | Append to an issue's notes (append-only; earlier notes survive) |
| `comment`| Append a comment to an issue                                   |
| `heartbeat` | Refresh the lease on a claim you hold (owner only)         |
| `unclaim`| Release a claim, optionally only while a given actor holds it  |
| `children`| List every child of a parent, closed children included        |
| `epicStatus` | Epic completion: total/closed children, close eligibility |
| `count`  | Count issues, optionally grouped by status/priority/type/...   |
| `config` | Read bd configuration and where each value comes from          |
| `doctor` | Capture bd doctor diagnostics (read-only; never repairs)        |

```bash
# What can I work on right now?
swamp model method run @maphew/bd ready my-tracker --json

# Claim an issue atomically as a named actor (race-safe across sessions)
swamp model method run @maphew/bd update my-tracker \
  --input '{"id":"bd-123","claim":true}'

# Release it only if it is still yours (compare-and-swap; no --force)
swamp model method run @maphew/bd unclaim my-tracker \
  --input '{"id":"bd-123","ifAssignee":"worker-7"}'

# Long run: keep the lease alive
swamp model method run @maphew/bd heartbeat my-tracker \
  --input '{"ids":["bd-123"]}'

# Record evidence mid-run without replacing anything
swamp model method run @maphew/bd note my-tracker \
  --input '{"id":"bd-123","text":"tests pass: 34/34"}'

# Close with a reason
swamp model method run @maphew/bd close my-tracker \
  --input '{"id":"bd-123","reason":"shipped in PR #9"}'

# Rich filtering via bd's query language (--json under the hood)
swamp model method run @maphew/bd query my-tracker \
  --input '{"q":"status=open AND type=bug","limit":20}'

# Include closed issues (bd excludes them by default)
swamp model method run @maphew/bd query my-tracker \
  --input '{"q":"priority<=1","includeClosed":true,"sort":"updated"}'

# Reopen a closed issue from a CI failure handler
swamp model method run @maphew/bd reopen my-tracker \
  --input '{"ids":["bd-123"],"reason":"regression reappeared"}'

# Link issues: bd-123 now depends on bd-124 (cycle-safe)
swamp model method run @maphew/bd dep my-tracker \
  --input '{"action":"add","issueId":"bd-123","dependsOnId":"bd-124"}'

# List what depends on bd-124 (upstream) as issue resources
swamp model method run @maphew/bd dep my-tracker \
  --input '{"action":"list","issueId":"bd-124","direction":"up"}'

# Nightly reaper: revert leases stale for over an hour
swamp model method run @maphew/bd reclaim my-tracker \
  --input '{"maxAge":"1h"}'

# Dependency graph for Mermaid rendering; upstream requires a rootId
swamp model method run @maphew/bd graph my-tracker \
  --input '{"rootId":"bd-123","direction":"both","depth":3}'

# Capture the live workflow context and git-authority policy
swamp model method run @maphew/bd prime my-tracker --json

# Persist only persistent memories, capped
swamp model method run @maphew/bd prime my-tracker \
  --input '{"memories":"only","maxMemories":20}'
```

Results are split by kind, so each is queryable with `swamp data query` and
referenceable from CEL expressions:

- `issue` — normalized issue records from `list`, `query`, `ready`, `show`,
  `create`, `update`, `close`, `reopen`, `dep list`, `note`, `comment`,
  `heartbeat`, `unclaim`, and `children`.
- `outcome` — a guard that did not hold; `outcome: "precondition_failed"` with
  the guard, expected value, and current holder/status.
- `epicStatus`, `issueCount`, `bdConfig`, `doctorReport` — one resource per
  reporting call.
- `dependencyGraph` — `nodes` (id, title, status), `edges` (`from`, `to`,
  `type`, meaning from depends on to), and `layers` in execution order from
  bd's own layout (null in all-open mode, where no root anchors the layering).
- `primeContext` — the `bd prime` text and parsed `agent.profile`.

`reclaim` maps to `bd reclaim --json`: `maxAge` is the grace window past lease
expiry (bd's default is 10m) and `ids` narrows to specific issues. Issues that
were actually reverted come back as issue resources with fresh fields, so a
nightly workflow can reclaim stale work and reassign it to the ready pool.

`prime` writes a single `primeContext` resource instead of issue resources: the
`bd prime` workflow text (the same session-close protocol and git-authority
policy harnesses inject at session start), the parsed `agent.profile` (the
explicit non-default profile bd prints, e.g. `team-maintainer`; null when the
profile is implicit, which is bd's conservative default), and a `generatedAt`
timestamp. Options mirror bd's own flags: `memories`
(`include`/`only`/`exclude`), `maxMemories`, and `maxMemoryChars` (bytes). Point
a workflow guard or report at it to assert the active profile without
re-running the CLI.

`list`, `query`, and `ready` take a `limit` (default 50, max 500) and set `truncated:
true` on every returned issue when more matched than the limit allowed. The
model passes `--limit <limit + 1>` to `bd` so the flag reflects bd's real cap
rather than its own 50-row default.

`query` runs `bd query --json` with the expression from `q` (required). Comparisons
are `field=value`/`!=`/`<`/`<=`/`>`/`>=` combined with `AND`/`OR`/`NOT` and
parentheses — bd's colon syntax (`status:open`) is not valid query language.
bd excludes closed issues unless `includeClosed: true` (the `--all` flag), so
`{"q":"status=closed"}` needs it to match anything.

## Global arguments

| Arg               | Default | Description                                            |
| ----------------- | ------- | ------------------------------------------------------ |
| `bdCommand`       | `bd`    | Path to the beads CLI                                  |
| `bdDir`           | `.`     | Project directory containing the `.beads/` database    |
| `defaultPriority` | `2`     | Fallback priority (0-4, 0=highest)                     |
| `defaultType`     | `task`  | Fallback issue type                                    |
| `actor`           | unset   | `--actor` for every mutating command. Defaults to `$BEADS_ACTOR` when set, otherwise bd resolves git `user.name` / `$USER`. Set it in workflows: two runs with the same implicit identity can silently claim the same bead |

## Concurrency and the claim lifecycle

`bd` keys claims on the actor, so the global `actor` arg is what makes a
workflow's claim safe. Every mutating method (`create`, `update`, `close`,
`reopen`, `dep add/remove`, `reclaim`, `note`, `comment`, `heartbeat`,
`unclaim`) passes `--actor` when one is configured. `create` also stamps
`created_by`, so the issue records which session made it.

Guards are the compare-and-swap half:

- `update` with `ifAssignee` and/or `ifStatus` applies only when the current
  holder/status matches.
- `unclaim` with `ifAssignee` releases only while that actor still holds it.

When a guard does not hold, nothing is written and the method **does not
throw**. It writes an `outcome` resource with
`outcome: "precondition_failed"`, the guard, the value you required, and the
current holder/status, so a workflow can branch instead of retrying. bd exits
13 for `update` guard mismatches; bd 1.3.2 exits 1 for `unclaim --if-assignee`
mismatches, so the extension matches bd's documented mismatch text rather than
the exit code alone. `--force` is never passed.

`heartbeat` keeps a held lease alive; only the current holder may call it, and
a failure is loud by design so a worker whose lease was reclaimed stops. The
lease is node-local in bd and writes no history, so a cadence below the TTL is
cheap. `unclaim` is the graceful-abort counterpart to `reclaim`: release your
own claim (or a specific actor's, guarded) instead of waiting for a global
stale sweep. `reclaim` remains available for dead-worker recovery.

`create`'s label+title deduplication is a best-effort guard for sequential
runs, not a concurrency primitive: it is a read-then-write, so two simultaneous
creates can still both insert. Use distinct titles where a duplicate matters,
and rely on `actor` + CAS guards for the claim path.

`note` and `comment` are append-only. The extension deliberately does not
expose description replacement as an evidence path: earlier notes are never
lost. (`bd`'s `--stdin` is a shell convenience with no workflow analogue; pass
`text`, or `file` for long evidence.)

## Issue fields

Issue resources carry what bd actually returns: `assignee`, `parent`,
`metadata`, `design`, `acceptanceCriteria`, `notes`, `dueAt`, `externalRef`,
`startedAt`, `closedAt`, `closeReason`, `leaseExpiresAt`, `heartbeatAt`,
counts, and labels. `createdAt`/`updatedAt` are **nullable**: bd omits fields
under `--brief`, and the extension preserves that absence rather than
stamping the current time and forging history.

`ready` exposes bd's full ready filter surface: `assignee`, `excludeLabels`,
`excludeTypes`, `labels` (all), `labelsAny`, `labelPattern`, `parent`,
`priority`, and `unassigned`.

## Config and doctor

`config` with a `key` reads one value; without one it reads the effective
configuration with provenance (`source`: default, database, git, file, ...),
which is how a health check can tell whether `agent.profile` is explicit or
inherited. Credential-looking keys (`*.token`, `*.api_key`, `ado.pat`,
`*.password`, ...) are stored and logged as `[redacted]`; pass
`revealSecrets: true` only when the caller genuinely needs the value, and note
that the model still never logs it. `doctor` captures the `bd doctor --json` report verbatim, including
`unsupported: true` when the storage mode cannot run doctor (embedded mode
does this with exit 0). The extension never infers health from doctor's exit
code, and it never repairs anything: instruction-file repair stays in the
consumer repo's own tooling.

## Error behavior

Failed `bd` invocations throw with the subcommand, exit code, and the captured
stderr/stdout, and are logged with the same detail — so failures show up
diagnostically in `swamp report get @swamp/method-summary` and workflow logs
instead of as opaque throws.

## Subprocess usage (expected warning)

This extension shells out to `bd` via `Deno.Command()`. On pull, the registry
flags subprocess-spawning extensions with a safety warning. That is expected
here: the entire purpose of this model is to drive the local `bd` CLI, and it
runs commands only in the configured `bdDir` with user-supplied arguments.
The `bdCommand` global arg exists so the binary path can be overridden without
editing the source.

## License

[MIT](./LICENSE). Source lives in
[maphew/swamp-extensions](https://github.com/maphew/swamp-extensions) under
`extensions/bd/`.
