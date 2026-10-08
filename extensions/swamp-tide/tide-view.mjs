#!/usr/bin/env node

/**
 * Render the latest swamp-tide report as a self-contained HTML page and
 * open it in a browser.
 *
 * The report markdown carries inline <svg> blocks; those are passed through
 * verbatim while the surrounding markdown is converted by pandoc.
 *
 * The page follows the system light/dark setting by default. The toggle in
 * the corner cycles system -> light -> dark and persists the choice.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATASTORE = join(process.cwd(), ".swamp", "datastore", "data");
const MODEL = "@maphew/swamp-tide";
const RESOURCE = "report-current";

async function latestReportPath() {
  const base = join(DATASTORE, MODEL);
  if (!existsSync(base)) {
    throw new Error(`no tide data at ${base} — run the tide workflow first`);
  }
  const instances = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const instance = instances[0];
  if (!instance) throw new Error("no tide instance dir");
  const resDir = join(base, instance, RESOURCE);
  const latest = join(resDir, "latest");
  if (!existsSync(latest)) throw new Error("no report-current/latest");
  const version = (await readFile(latest, "utf8")).trim();
  const raw = join(resDir, version, "raw");
  if (!existsSync(raw)) throw new Error(`report version ${version} missing`);
  return raw;
}

/** Split markdown into markdown chunks and verbatim SVG blocks. */
function splitContent(md) {
  const re = /<svg[\s\S]*?<\/svg>/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) parts.push({ kind: "md", text: md.slice(last, m.index) });
    parts.push({ kind: "svg", text: m[0] });
    last = re.lastIndex;
  }
  if (last < md.length) parts.push({ kind: "md", text: md.slice(last) });
  return parts;
}

function mdToHtml(md) {
  if (!md.trim()) return "";
  return execFileSync("pandoc", ["-f", "markdown", "-t", "html5", "--syntax-highlighting=none"], {
    input: md,
    encoding: "utf8",
  }).trim();
}

const STYLE = `
  :root {
    color-scheme: light;
    --bg: #fbfaf7; --fg: #1f2430; --muted: #5a6270;
    --border: #dfe3e8; --code-bg: #eef0f3; --link: #0e7a4d;
    --btn-bg: rgba(31,36,48,.06); --btn-fg: #1f2430;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #15181e; --fg: #e6e8eb; --muted: #9aa1ad;
      --border: #2e3440; --code-bg: #232933; --link: #4cc38a;
      --btn-bg: rgba(230,232,235,.1); --btn-fg: #e6e8eb;
    }
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #fbfaf7; --fg: #1f2430; --muted: #5a6270;
    --border: #dfe3e8; --code-bg: #eef0f3; --link: #0e7a4d;
    --btn-bg: rgba(31,36,48,.06); --btn-fg: #1f2430;
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #15181e; --fg: #e6e8eb; --muted: #9aa1ad;
    --border: #2e3440; --code-bg: #232933; --link: #4cc38a;
    --btn-bg: rgba(230,232,235,.1); --btn-fg: #e6e8eb;
  }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    max-width: 820px; margin: 0 auto; padding: 3rem 1.5rem 6rem;
    color: var(--fg); background: var(--bg);
  }
  h1 { font-size: 1.75rem; border-bottom: 2px solid var(--border); padding-bottom: .4rem; }
  h2 { font-size: 1.25rem; margin-top: 2rem; }
  ul, ol { line-height: 1.7; }
  code { background: var(--code-bg); padding: .05rem .3rem; border-radius: 3px; font-size: .88em; }
  pre { background: #1f2430; color: #e6e8eb; border: 1px solid var(--border); padding: 1rem; border-radius: 6px; overflow:auto; }
  svg { max-width: 100%; height: auto; display: block; margin: .5rem 0 1.5rem; }
  a { color: var(--link); }
  .meta { color: var(--muted); font-size: .9rem; }
  #theme-toggle {
    position: fixed; top: 1rem; right: 1rem; z-index: 1;
    font: inherit; font-size: 1rem; line-height: 1;
    width: 2rem; height: 2rem; border-radius: 50%;
    border: 1px solid var(--border);
    background: var(--btn-bg); color: var(--btn-fg);
    cursor: pointer;
  }
  #theme-toggle:hover { border-color: var(--muted); }
`;

/** Applied before first paint so a stored preference never flashes. */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem("tide-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

/** Cycle system -> light -> dark -> system; persist the choice. */
const THEME_TOGGLE = `
(function () {
  var root = document.documentElement;
  var btn = document.getElementById("theme-toggle");
  function stored() {
    try { return localStorage.getItem("tide-theme"); } catch (e) { return null; }
  }
  function save(v) {
    try {
      if (v) localStorage.setItem("tide-theme", v);
      else localStorage.removeItem("tide-theme");
    } catch (e) {}
  }
  function effective() {
    var t = stored();
    if (t === "light" || t === "dark") return t;
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    return "light";
  }
  function render() {
    var pref = stored();
    var eff = effective();
    btn.textContent = eff === "dark" ? "\\u263E" : "\\u2600";
    var next = pref === null ? "light" : pref === "light" ? "dark" : "system";
    btn.title = "Theme: " + (pref || "system") + " (click for " + next + ")";
    btn.setAttribute("aria-label", "Theme: " + (pref || "system") + ", click to switch to " + next);
  }
  btn.addEventListener("click", function () {
    var pref = stored();
    var next = pref === null ? "light" : pref === "light" ? "dark" : null;
    save(next);
    if (next) root.setAttribute("data-theme", next);
    else root.removeAttribute("data-theme");
    render();
  });
  render();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  }
})();
`;

async function main() {
  const path = await latestReportPath();
  const md = await readFile(path, "utf8");
  const body = [];
  for (const part of splitContent(md)) {
    body.push(part.kind === "svg" ? part.text : mdToHtml(part.text));
  }
  const html = `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Swamp Tide</title>
  <style>${STYLE}</style>
  <script>${THEME_BOOTSTRAP}<\/script>
</head><body>
<button id="theme-toggle" type="button"></button>
${body.join("\n")}
<script>${THEME_TOGGLE}<\/script>
</body></html>`;

  const outDir = join(tmpdir(), "swamp-tide");
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, "tide.html");
  await writeFile(out, html, "utf8");
  console.log(out);
  execFileSync("xdg-open", [out], { stdio: "ignore" });
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
