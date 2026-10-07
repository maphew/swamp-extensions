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

```bash
# What can I work on right now?
swamp model method run @maphew/bd ready my-tracker --json

# Claim an issue atomically (assignee + in_progress, race-safe)
swamp model method run @maphew/bd update my-tracker \
  --input '{"id":"bd-123","claim":true}'

# Close with a reason
swamp model method run @maphew/bd close my-tracker \
  --input '{"id":"bd-123","reason":"shipped in PR #9"}'

# Rich filtering via bd's query language (--json under the hood)
swamp model method run @maphew/bd query my-tracker \
  --input '{"q":"status=open AND type=bug","limit":20}'

# Include closed issues (bd excludes them by default)
swamp model method run @maphew/bd query my-tracker \
  --input '{"q":"priority<=1","includeClosed":true,"sort":"updated"}'
```

Every method writes normalized issue resources (`spec: issue`), so results are
queryable with `swamp data query` and referenceable from CEL expressions.

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

[AGPL-3.0](./LICENSE). Source lives in
[maphew/swamp-extensions](https://github.com/maphew/swamp-extensions) under
`extensions/bd/`.
