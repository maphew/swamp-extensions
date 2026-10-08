# @maphew/swamp-tide

Troll the swamp club activity logs to find when people — and
their agents — are participating. A 7x24 participation heatmap
over the club feed, with peak-slot detection and charts.

## Methods

- **collect** — harvest the club activity feed into a
  normalized event stream
- **heatmap** — bucket events into a 7x24 grid and render the
  tide report

## Usage

Create the model and run it through the companion workflow:

```bash
# Create the model instance
swamp model create @maphew/swamp-tide tide

# Run collect + heatmap via the scheduled workflow
swamp workflow run swamp-tide

# Or run the methods directly
swamp model method run tide collect
swamp model method run tide heatmap \
  --input 'events=<json array>'
```

Read the results with CEL:

```bash
# Participation heatmap with peak slots
swamp data query 'name == "heatmap-current"' --select content

# Normalized events
swamp data query 'name == "events-current"' --select content
```

## Configuration

Global arguments (per model instance):

- `feedUrl` — activity feed RSS (default `https://swamp-club.com/feed.xml`)
- `timezone` — IANA timezone for the buckets (default `UTC`)
- `source` — label recorded on collected events (default `feed`)

## Output

- `events-current` — normalized events (id, ts, source, kind,
  actor, actorKind, url, title, detail)
- `heatmap-current` — 168-cell grid, top-3 peaks, and the
  hour/weekday/month/daily chart profiles
- `report-current` — markdown tide report with an ASCII density
  grid and inline SVG charts styled after the club device
  Activity and Trajectory pages

## Viewer

The extension bundles `tide-view`, which renders the latest tide
report as a self-contained HTML page (inline SVG charts
included) and opens it in your browser:

```bash
node ~/.swamp/pulled-extensions/@maphew/swamp-tide/files/tide-view.mjs
```

For convenience, you can create an alias:

```bash
alias tide-view='node ~/.swamp/pulled-extensions/@maphew/swamp-tide/files/tide-view.mjs'
```

Or add the extension's files directory to your PATH:
```bash
export PATH="$PATH:$HOME/.swamp/pulled-extensions/@maphew/swamp-tide/files"
```

## Preview

Once you have generated tide data by running the swamp-tide workflow, you can preview the output by running:
```bash
tide-view
```

This will generate a self-contained HTML file and open it in your default browser, showing the latest tide report with SVG charts.

The page follows the system light/dark setting by default. The
toggle in the corner cycles system -> light -> dark and
remembers the choice.
