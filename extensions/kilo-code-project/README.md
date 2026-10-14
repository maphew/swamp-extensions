# @maphew/kilo-code-project

Discover and summarize [Kilo Code](https://kilocode.ai) CLI configuration for a
project. Walks the project and, optionally, global and legacy config roots, and
records commands, agents, skills, instruction files, permissions, MCPs, config
files, and Agent Manager state — **without running Kilo or mutating project
files**.

## Install

```bash
swamp extension pull @maphew/kilo-code-project
swamp model create @maphew/kilo-code-project kilo-inventory
```

## Methods

| Method      | Purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| `discover`  | Walk roots and write a structured inventory plus markdown summary |
| `summarise` | Alias for `discover`                                           |

```bash
swamp model method run kilo-inventory discover
swamp model method run kilo-inventory summarise

# Read the structured inventory
swamp data query 'name == "inventory-current"' --select content

# Read the markdown summary
swamp data query 'name == "summary-current"' --select content
```

## Configuration

Global arguments (per model instance):

- `projectDir` — project directory to inspect (default `.`, so the model stays
  portable across machines)
- `includeGlobal` — also inspect global Kilo Code config roots (default `true`)
- `includeLegacyPaths` — include legacy `.kilocode`/`.opencode` roots (default
  `true`)
- `includeAgentManager` — inspect `.kilo/agent-manager.json` metadata (default
  `true`)
- `redactSecrets` — replace values whose key looks secret with `[redacted]`
  (default `true`)
- `maxFileBytes` — maximum bytes read from a discovered text/config file
  (default `200000`)

## Secret redaction

With `redactSecrets: true` (the default), parsed JSON/JSONC/YAML config objects
have any key matching `api_key`, `token`, `secret`, `password`, `authorization`,
`credential`, `private_key`, or `headers` replaced with the literal string
`[redacted]` before being written. Redaction is key-based and best-effort — it
does not scrub secrets embedded in free text or markdown.

## Output

- `inventory-current` — discovered files, configs, skills, agents, MCPs, and
  warnings
- `health-current` — configuration health warnings from the latest run
- `summary-current` — markdown summary

## License

AGPL-3.0. See [LICENSE](./LICENSE).
