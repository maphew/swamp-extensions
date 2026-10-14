#!/usr/bin/env bash
# pulse-view — show the latest club-pulse dashboard in a browser.
#
# The dashboard is a self-contained HTML artifact produced by the club-pulse
# `pulse` method (refreshed every 5 min by the club-pulse workflow). This script
# pulls it out of the data store, writes it to a temp file, and shows it.
#
# Repo resolution: uses $SWAMP_REPO_DIR if set, else the current directory.
# Run it from your swamp repo (or set SWAMP_REPO_DIR to one).
#
# Opening strategy:
#   - WSL: launch the Windows default browser via cmd.exe/explorer.exe (no
#     ctrl-click needed). Also prints a Windows UNC path you can ctrl-click.
#   - Linux/macOS: xdg-open / gio / open.
#   - Headless: prints the path only.
#
# Usage: pulse-view [repo-dir]
set -euo pipefail

repo_dir="${1:-${SWAMP_REPO_DIR:-$PWD}}"
out_dir="${TMPDIR:-/tmp}/club-pulse"
out="${out_dir}/pulse.html"
query='modelName == "club-pulse" && name == "pulse-dashboard"'

mkdir -p "$out_dir"

html="$(swamp data query "$query" --select content --single --repo-dir "$repo_dir" 2>/dev/null || true)"

# First run (or a fresh checkout): no dashboard yet — generate one from samples.
if [[ -z "$html" || "$html" != "<!doctype html>"* ]]; then
  swamp behavior run club-pulse pulse --repo-dir "$repo_dir" >/dev/null 2>&1 || true
  html="$(swamp data query "$query" --select content --single --repo-dir "$repo_dir" 2>/dev/null || true)"
fi

if [[ -z "$html" || "$html" != "<!doctype html>"* ]]; then
  echo "pulse-view: no dashboard yet — collect samples first:" >&2
  echo "  swamp workflow run club-pulse" >&2
  exit 1
fi

printf '%s' "$html" > "$out"

# --- WSL detection ----------------------------------------------------------
is_wsl=0
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
  is_wsl=1
fi

# A link the terminal can ctrl-click. Under WSL a Windows UNC path opens in the
# Windows default app; elsewhere the plain local path.
link="$out"
if [[ "$is_wsl" == 1 ]] && command -v wslpath >/dev/null 2>&1; then
  link="$(wslpath -w "$out" 2>/dev/null || printf '%s' "$out")"
fi

# --- try to open a browser (backgrounded; never blocks or hides the link) ---
open_browser() {
  if command -v wslview >/dev/null 2>&1 && wslview "$out" >/dev/null 2>&1; then
    return 0
  fi
  if [[ "$is_wsl" == 1 ]]; then
    if [[ -x /mnt/c/Windows/System32/cmd.exe ]] &&
      /mnt/c/Windows/System32/cmd.exe /c start "" "$link" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -x /mnt/c/Windows/explorer.exe ]] &&
      /mnt/c/Windows/explorer.exe "$link" >/dev/null 2>&1; then
      return 0
    fi
  fi
  command -v xdg-open >/dev/null 2>&1 && xdg-open "$out" >/dev/null 2>&1 && return 0
  command -v gio >/dev/null 2>&1 && gio open "$out" >/dev/null 2>&1 && return 0
  command -v sensible-browser >/dev/null 2>&1 &&
    sensible-browser "$out" >/dev/null 2>&1 && return 0
  command -v open >/dev/null 2>&1 && open "$out" >/dev/null 2>&1 && return 0
  return 1
}

open_browser >/dev/null 2>&1 &
disown 2>/dev/null || true

echo "$link"
