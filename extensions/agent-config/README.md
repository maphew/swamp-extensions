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

| Method                   | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `inventory`              | Per-tool on-disk state vs enrollment and customisation + report        |
| `checkDrift`             | Drift findings only                                                     |
| `probeTerminalChain`     | Detect outer terminal, multiplexer, platform, modified-Enter capability |
| `readDefaultTerminal`    | Read gsettings + xdg-terminal-exec default-terminal state (read-only)   |
| `planKeymap`             | Turn a probe into the effective submit/newline chords and config lines  |
| `applyPiKeybindings`     | Idempotently merge the planned bindings into pi's `keybindings.json`    |
| `applyGhosttyConfig`     | Idempotently merge font-family + `ctrl+enter` unbind into Ghostty config |
| `applyXdgDefaultTerminal`| Point xdg-terminal-exec at the desired desktop entry (Linux/GNOME)      |
| `verifyGhosttyConfig`    | Check `ghostty +show-config` dropped the ctrl+enter binding and font     |

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

## Terminal keymap setup

The `probeTerminalChain` → `planKeymap` → `apply*` → `verifyGhosttyConfig`
methods implement the deterministic parts of the `terminal-keymap-setup` skill:
probe the input chain (OS → outer terminal → multiplexer → pi), decide whether
`Ctrl+Enter` can be reported distinctly (Kitty keyboard protocol) or whether the
plan must fall back to `Alt+Enter`, then idempotently write the pi keybindings,
the Ghostty config, and the xdg default terminal. The physical keystroke test
cannot be automated and stays a manual gate in
`workflow-terminal-keymap-setup.yaml`.

The capability table is a planning hint, not a guarantee — re-probe rather than
trusting it across OS/terminal versions.

## Output

- `inventory-current` — per-tool on-disk state vs enrollment and customisation
- `drift-current` — drift findings between enrollment, custom definitions, and
  disk
- `report-current` — markdown report
- `terminal-probe` — outer terminal / multiplexer / platform classification
- `xdg-default-terminal-current` — current gsettings + xdg-terminal-exec state
- `keymap-plan` — effective chords and config snippets
- `pi-keybindings`, `ghostty-config`, `xdg-default-terminal` — apply results
- `ghostty-verify` — parsed Ghostty config check

## License

MIT. See [LICENSE](./LICENSE).
