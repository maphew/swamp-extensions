# @maphew/retro

[![swamp extension](https://img.shields.io/badge/swamp-extension-00C756.svg)](https://github.com/swamp-club/swamp)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

An [swamp](https://github.com/swamp-club/swamp) extension that runs the
**Agent Session Retrospective Playbook** as a swamp model: mine past coding
sessions for evidence about how you and your agents work together, and keep a
cumulative, evidence-backed findings register across rounds.

Unlike a work-log digest, the goal here is **process improvement**: every
finding is tagged with a friction dimension, must cite evidence, and is
eventually routed to a durable home (a skill, an AGENTS.md rule, a wrapper, an
upstream issue) with a `verify-by` line so a later round can confirm the
friction actually disappeared.

## Relationship to existing extensions

This is deliberately **not** a fork of
[`@scale-venture-partners/claude-log-digest`](https://github.com/scale-venture-partners/swamp-claude-log-digest),
which is the closest thing in the registry. That extension summarizes recent
Claude Code work and proposes new skills as a PR. `@maphew/retro` differs on
purpose:

| | claude-log-digest | @maphew/retro |
| --- | --- | --- |
| Runtimes | Claude Code only | Claude Code, Codex CLI, Amp |
| Unit of output | a weekly activity digest + skill PR | a cumulative findings register |
| Analysis frame | "what did I work on" | human×agent friction taxonomy (13 tags) |
| Discipline | free-form | evidence quotes, severity, cost, recurrence counts |
| Lifecycle | one shot | candidate → recurring → promoted → verified-fixed |
| Closed loop | none | `verify-by` per promotion, checked next round |
| Privacy gate | none | digests stay untracked; redaction rule documented |

The two are complementary. The per-session condensing and skill-PR mechanics
from `claude-log-digest` informed this design and are credited here; if you want
a weekly summary PR rather than a retrospective, use that extension instead.

## Methods

| Method | LLM? | What it does |
| --- | --- | --- |
| `inventory` | no | Scans the configured session stores into a ledger, classifies each session (trivial / subagent / inflight / pending / lost), and selects the next batch of `batchSize` sessions as a round. |
| `strip` | no | Mechanically condenses the batch's transcripts (per-runtime adapters) into one resource per session. Cheap and inspectable before any model call. |
| `digest` | yes (cheap tier) | One rubric-driven call per stripped session: task, outcome, effectiveness, tagged friction with quotes, wins, delegation, user-style, recommendations. |
| `synthesize` | yes (strong tier) | Merges the batch digests into the cumulative register: bumps sightings, promotes `candidate` → `recurring`, adds new findings, and writes the round summary. |
| `promote` | no | Renders the actionable findings (≥2 sightings, not yet promoted) with their durable home and `verify-by`. |
| `status` | no | Summarizes ledger coverage and register size. |

State is written both as swamp resources (`ledger`, `batch`, `state`,
`stripped`, `digest`, `register`, `round`, `recommendation`) and as mirror
files under `retroDir` (`ledger.tsv`, `findings.md`, `batches/round-NN.md`,
`promotions.md`, and gitignored `digests/`).

## Install

```bash
swamp extension pull @maphew/retro
swamp model create @maphew/retro retro
```

## Configure

Anthropic (default) needs a key in a vault:

```bash
swamp vault create local_encryption secrets
printf '%s' "$ANTHROPIC_API_KEY" | swamp vault put secrets ANTHROPIC_API_KEY
swamp model edit retro
```

| Arg | Default | Notes |
| --- | --- | --- |
| `provider` | `anthropic` | `anthropic` (Messages API) or `command` (shell out, e.g. to `codex`) |
| `apiKey` | — | `${{ vault.get(secrets, ANTHROPIC_API_KEY) }}` (provider=anthropic) |
| `apiUrl` | Anthropic Messages endpoint | override for a proxy |
| `model` | `claude-sonnet-4-5` | synthesis tier; pin explicitly |
| `digestModel` | = `model` | per-session digests — point this at a cheaper tier |
| `command` | — | provider=command: reads the prompt on stdin, writes the reply to stdout |
| `runtimes` | `claude-code` | comma list of `claude-code`, `codex`, `amp` |
| `retroDir` | `retro` | mirror-file directory in the swamp repo |
| `home` | `$HOME` | root for default store paths |
| `projectsDir` / `codexSessionsDir` / `ampThreadsDir` | `$HOME/.claude/projects` / `$HOME/.codex/sessions` / `$HOME/.local/share/amp/threads` | store overrides |
| `sinceDays` | `0` (all) | lookback window |
| `minSizeKb` / `minMessages` | `100` / `8` | trivial-session thresholds |
| `inflightMinutes` | `10` | transcript modified more recently is the running session |
| `batchSize` | `5` | sessions per round |
| `includeScopes` / `excludeScopes` | — | comma globs on scope labels |
| `maxCharsPerSession` | `120000` | per-session strip cap (head+tail elision) |
| `seedRegisterFile` | — | optional JSON register to seed on first `synthesize` |

### Quota relief via a coding-agent CLI

To run the model calls on a different vendor's plan (as the playbook's
`codex-agent scout` does), set `provider: command` and point `command` at a CLI
that reads a prompt on stdin:

```yaml
globalArguments:
  provider: command
  command: "codex exec --sandbox read-only -"
```

## Example

```bash
# 1. inventory all three runtimes and pick the first batch of 5
swamp model method run retro inventory
swamp data get retro ledger --json | jq '.rows | group_by(.status) | map({(.[0].status): length})'

# 2. condense the batch (no model calls)
swamp model method run retro strip

# 3. per-session digests, then merge into the register
swamp model method run retro digest
swamp model method run retro synthesize

# 4. see the promotion queue
swamp model method run retro promote
cat retro/promotions.md
```

## Workflow

Wire the whole round as one unit, and schedule it:

```yaml
jobs:
  - name: round
    steps:
      - name: inventory
        task: { type: model_method, modelIdOrName: retro, methodName: inventory }
        dependsOn: []
      - name: strip
        task: { type: model_method, modelIdOrName: retro, methodName: strip }
        dependsOn: [{ step: inventory, condition: { type: succeeded } }]
      - name: digest
        task: { type: model_method, modelIdOrName: retro, methodName: digest }
        dependsOn: [{ step: strip, condition: { type: succeeded } }]
      - name: synthesize
        task: { type: model_method, modelIdOrName: retro, methodName: synthesize }
        dependsOn: [{ step: digest, condition: { type: succeeded } }]
      - name: promote
        task: { type: model_method, modelIdOrName: retro, methodName: promote }
        dependsOn: [{ step: synthesize, condition: { type: succeeded } }]
trigger:
  schedule: "0 9 * * 1"
```

## Privacy

Transcripts can contain secrets, tokens, and private paths. `strip`/`digest`
write digests under `retroDir/digests/`; **keep that directory untracked**.
Only `findings.md`, `batches/`, and `ledger.tsv` are meant to be committed, and
those must be redaction-checked (evidence quotes ≤ 25 words, no credentials).

## Development

```bash
deno check extensions/retro/src/retro.ts
deno lint extensions/retro/src/
deno test --allow-read --allow-write --allow-env extensions/retro/src/
swamp extension quality extensions/retro/manifest.yaml
```

## License

AGPL-3.0. See [LICENSE](./LICENSE).
