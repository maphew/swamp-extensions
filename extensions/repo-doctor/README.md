# @maphew/repo-doctor

Repository hygiene checks for [swamp](https://github.com/swamp-club/swamp)
repos. Audits the portability and hygiene problems the CLI does not surface as
failures, and writes both structured resources and a markdown report.

## What it checks

- **Hardcoded absolute home paths** — `/home/<user>/...` or `/Users/<user>/...`
  literals in model and workflow sources. A path baked into a source breaks the
  repo the moment it is cloned to a different machine or username.
- **Pulled-extension integrity** — extensions listed in the lockfile whose
  source files are missing (the types resolve but blow up at run time).
- **`.gitignore` coverage** — generated `.swamp/` artifacts that are not
  ignored.

## Install

```bash
swamp extension pull @maphew/repo-doctor
swamp model create @maphew/repo-doctor repo-doctor
```

## Methods

| Method            | Purpose                                                     |
| ----------------- | ----------------------------------------------------------- |
| `scan`            | Run every check and write a combined markdown report         |
| `findPaths`       | Hardcoded absolute-path findings only                        |
| `checkExtensions` | Pulled-extension source integrity only                       |
| `checkGitignore`  | `.swamp/` gitignore coverage only                            |

```bash
# Full audit
swamp model method run repo-doctor scan

# One check at a time
swamp model method run repo-doctor findPaths
swamp model method run repo-doctor checkExtensions
swamp model method run repo-doctor checkGitignore

# Read the report
swamp data query 'name == "report-current"' --select content
```

## Configuration

Global arguments (per model instance):

- `projectDir` — swamp repo root to audit (default `.`, so the model stays
  portable across machines)
- `sourceDirs` — repo-relative directories scanned for hardcoded absolute paths
  (default `["extensions/models", "workflows"]`)
- `includeWorkflows` — also scan `workflows/` (default `true`)

## Output

- `scan-current` — combined report: `healthy`, `errorCount`, `warningCount`,
  and every finding (check, severity, file, line, message, detail)
- `paths-current` — hardcoded absolute-path findings
- `extensions-current` — pulled-extension integrity
- `gitignore-current` — `.swamp/` gitignore coverage
- `report-current` — markdown report

## Notes

`scan` treats the repo as unhealthy when any finding has `error` severity; the
`healthy` flag and counts are intended for workflow gates and CEL conditions.

## License

AGPL-3.0. See [LICENSE](./LICENSE).
