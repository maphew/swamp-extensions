# @maphew/pr-sweep-config

File-backed configuration store for [swamp](https://github.com/swamp-club/swamp)
PR sweep repository pairs. Each pair describes an upstream repo and a fork to
sweep, plus the local checkout, agent, and base branch. The companion to the
`@maphew/pr-sweep` workflow.

The store lives at `.swamp/pr-sweep-config.json` (gitignored runtime state) so a
daemon-side workflow and an interactive TUI agree on one file.

## Install

```bash
swamp extension pull @maphew/pr-sweep-config
swamp model create @maphew/pr-sweep-config pr-sweep-config
```

## Methods

| Method          | Purpose                                                     |
| --------------- | ----------------------------------------------------------- |
| `discover`      | Load the current configuration and write a markdown summary |
| `addRepoPair`   | Add a repository pair                                      |
| `removeRepoPair`| Remove a pair by id                                         |
| `toggleRepoPair`| Toggle a pair's enabled state                              |
| `updateRepoPair`| Update a pair's fields                                     |

```bash
# Inspect the current config
swamp model method run pr-sweep-config discover

# Add a pair (id is derived from the name)
swamp model method run pr-sweep-config addRepoPair \
  --input name="kilocode" \
  --input upstreamRepo="Kilo-Org/kilocode" \
  --input forkRepo="maphew/kilocode" \
  --input workdir="/path/to/kilocode"

# Read the summary
swamp data query 'name == "summary-current"' --select content
```

## Configuration

The model takes no global arguments. Repository pairs carry:

- `id` — derived from `name` (lowercase, non-alphanumerics collapsed to `-`)
- `name`, `upstreamRepo`, `forkRepo`, `workdir`
- `enabled` — include in sweeps (default `true`)
- `agent` — headless agent (`claude`, `codex`, `opencode`, `kilo`; default `kilo`)
- `mainBranch` — base branch (default `main`)
- `swampRepoDir` — swamp repo that owns the workflow (default `.`)

## Output

- `config-current` — the repository pair configuration
- `summary-current` — markdown summary table

## License

AGPL-3.0. See [LICENSE](./LICENSE).
