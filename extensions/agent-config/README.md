# @maphew/agent-config

Inventory and drift check for AI-tool configs enrolled in a
[swamp](https://github.com/swamp-club/swamp) repo.

Swamp manages agent tool configs in two places, and they mean different things:

- `.swamp.yaml` `tools:` is the **enrollment list**. Every tool on it gets a
  config tree materialised and kept in sync by `swamp repo upgrade`, using
  swamp's built-in defaults.
- `.swamp-custom-tools.yaml` holds **custom definitions** — the subset of
  enrolled tools whose skills dir, instructions file, or gitignore entries
  deviate from the built-in default. A tool absent from this file is still
  managed, just with stock settings.

Conflating the two produces false alarms: a repo that enrolls
`claude, codex, opencode, kilo` but customises only `kilo` is healthy, not
drifting. This model reads both files, so enrollment drives "enrolled?" and the
custom manifest only supplies overrides.

## What actually drifts

- a tool is enrolled but its config tree never appeared
- a custom definition names a tool that is no longer enrolled
- a declared instructions file or skills dir does not exist
- a custom gitignore entry is missing from `.gitignore`
- a config tree exists for a tool nobody enrolled and nobody owns

## Install

```bash
swamp extension pull @maphew/agent-config
swamp model create @maphew/agent-config agent-config
```

## Methods

| Method       | Purpose                                                       |
| ------------ | ------------------------------------------------------------- |
| `inventory`  | Per-tool on-disk state vs enrollment and customisation + report |
| `checkDrift` | Drift findings only                                            |

```bash
# Full inventory plus markdown report
swamp model method run agent-config inventory

# Just the drift findings (useful as a workflow gate)
swamp model method run agent-config checkDrift

# Read the drift report
swamp data query 'name == "drift-current"' --select content
```

## Configuration

Global arguments (per model instance):

- `projectDir` — swamp repo root to inspect (default `.`, so the model stays
  portable across machines)
- `enrollmentManifest` — enrollment manifest whose `tools:` list swamp manages
  (default `.swamp.yaml`)
- `customToolsManifest` — custom tool definitions (default
  `.swamp-custom-tools.yaml`)
- `gitignoreFile` — gitignore to check custom entries against (default
  `.gitignore`)
- `configDirs` — repo-relative config dirs corresponding to an AI tool
  (default `[".claude", ".codex", ".cursor", ".kilo", ".kilocode", ".opencode"]`)
- `projectOwnedDirs` — config dirs the project maintains by hand rather than
  delegating to swamp, listed so they are not reported as unmanaged (default
  `[]`)

## Output

- `inventory-current` — per-tool on-disk state vs enrollment and customisation
- `drift-current` — drift findings between enrollment, custom definitions, and
  disk
- `report-current` — markdown report

## License

AGPL-3.0. See [LICENSE](./LICENSE).
