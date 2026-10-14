# @maphew/club-pulse

Swamp Club **points velocity** for a member. The club API exposes only
point-in-time leaderboard snapshots (no timestamped XP history), so velocity is
derived by sampling on a cadence and differencing consecutive samples.

- `sample` fetches the current club-points snapshot and appends it to a rolling
  buffer.
- `pulse` reads the buffer, diffs consecutive samples, buckets the deltas by
  minute / hour / day, and renders a markdown report plus a self-contained HTML
  dashboard.

The resolution of the result is bounded by the sampling cadence: 5-minute
sampling yields 5-minute steps, not true per-minute events. This is called out
in the report itself.

Metric choice: this tracks *club points* (the leaderboard score), not Genesis
quest XP (`swamp quest`). Quest XP only moves when a challenge completes, so it
is permanently flat once all challenges are done; club points keep moving.

## Install

```bash
swamp extension pull @maphew/club-pulse
swamp model create @maphew/club-pulse club-pulse
```

## Methods

| Method   | Purpose                                                          |
| -------- | ---------------------------------------------------------------- |
| `sample` | Fetch the current club-points snapshot and append it to the buffer |
| `pulse`  | Bucket recorded samples into minute/hour/day deltas and render   |

```bash
# One sample, then render
swamp model method run club-pulse sample
swamp model method run club-pulse pulse

# Or run the bundled workflow (samples + renders on a schedule)
swamp workflow run club-pulse

# Read the outputs
swamp data query 'name == "pulse-current"' --select content
swamp data query 'name == "pulse-report-current"' --select content
```

## Configuration

Global arguments (per model instance):

- `username` — Swamp Club username to track (**required**)
- `clubUrl` — Swamp Club base URL (default `https://swamp-club.com`)
- `maxSamples` — maximum samples retained in the rolling buffer (default `5000`)
- `reportBuckets` — how many recent buckets to render per granularity (default
  `24`)
- `timeoutMs` — per-request timeout in milliseconds (default `15000`)

Example instance:

```bash
swamp model create @maphew/club-pulse club-pulse \
  --input username=your-name
```

## Output

- `samples-current` — rolling buffer of timestamped samples
- `pulse-current` — bucketed deltas (minute / hour / day) and totals
- `pulse-report-current` — markdown pulse report
- `pulse-dashboard` — self-contained HTML dashboard

## Workflow

The bundled `club-pulse` workflow runs `sample` then `pulse` on a 5-minute
schedule (`*/5 * * * *`). Edit the cron in the workflow to change resolution.

## Viewer

The extension bundles `pulse-view.sh`, which pulls the latest dashboard artifact
from the data store, writes it to a temp file, and opens it (WSL-aware; falls
back to printing the path on a headless box). Run it from your swamp repo (or
set `SWAMP_REPO_DIR`):

```bash
~/.swamp/pulled-extensions/@maphew/club-pulse/files/pulse-view.sh
```

## License

AGPL-3.0. See [LICENSE](./LICENSE).
