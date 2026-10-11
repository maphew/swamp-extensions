# swamp-extensions

Home for [`swamp`](https://github.com/swamp-club/swamp) extensions published by
maphew. Each extension lives in its own self-contained package directory under
`extensions/` with a `manifest.yaml`, source, README, and LICENSE, so a single
package can be pushed to the swamp registry with:

```bash
swamp extension push extensions/<package>/manifest.yaml
```

## Packages

| Package        | Model type                  | Purpose                                                        |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| `bd`           | `@maphew/bd`                | Beads (`bd`) issue tracker bridge for swamp workflows           |
| `swamp-tide`   | `@maphew/swamp-tide`        | Swamp Club activity heatmap, charts, and report                 |
| `repo-doctor`  | `@maphew/repo-doctor`       | Repo hygiene: hardcoded home paths, extension integrity, gitignore |
| `agent-config` | `@maphew/agent-config`      | Enrolled AI-tool config inventory and drift check               |
| `kilo-code-project` | `@maphew/kilo-code-project` | Kilo Code CLI config/inventory discovery                 |
| `club-pulse`   | `@maphew/club-pulse`        | Swamp Club points velocity: samples, buckets, and dashboard     |
| `pr-sweep-config` | `@maphew/pr-sweep-config` | PR sweep repository-pair configuration store                  |
| `pr-sweep`     | `@maphew/pr-sweep`          | Sweep fork PRs: review, update, and merge, with per-PR results  |
| `agent-task`   | `@maphew/agent-task`        | Headless agent dispatch: queue filter, branch+run, and fan-out sweep |
| `handoff`      | `@maphew/handoff`           | Exact-state handoffs: Git + Bead snapshot, narrative, resume brief |
| `housekeeping` | `@maphew/housekeeping`      | Generic housekeeping sweep: git, worktrees, temp/processes/disk, tracker hygiene |
| `retro`        | `@maphew/retro`             | Mine Claude Code, Codex, and Amp sessions into an evidence-backed findings register |

## Layout

```
extensions/
  <package>/
    manifest.yaml     # swamp extension manifest (name, version, models, files)
    README.md         # package documentation, published with the extension
    LICENSE           # package license
    src/              # TypeScript model definitions
```

Each manifest sets `paths.base: manifest`, so `models:` entries resolve
relative to the manifest. Keep sources in `src/` (or any directory other than
a typed dir like `models/`) — an entry of `models/foo.ts` would land at
`models/models/foo.ts` in the published archive and push refuses it.

Package names keep their `@maphew/` registry scope; this repository is the
source of truth, not the scope.

## Install

```bash
swamp extension pull @maphew/bd
swamp model create @maphew/bd my-tracker
```

## Contributing

1. Edit the package under `extensions/<package>/`.
2. Bump `version` in its `manifest.yaml` (per-version release notes go to
   `swamp extension push --release-notes`).
3. Verify: `deno check extensions/<package>/src/*.ts` and
   `swamp extension push --dry-run --repo-dir <any swamp repo> extensions/<package>/manifest.yaml`.
   `--repo-dir` is needed because this repo is not itself a swamp repo.
4. Push the extension, then commit.

## License

MIT. See [LICENSE](./LICENSE).