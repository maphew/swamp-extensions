/**
 * Unit tests for the pure helpers in {@link ./agent_config.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  basename,
  classifyTerminal,
  desktopEntryDirs,
  dirname,
  joinPath,
  mergeGhosttyConfig,
  mergePiKeybindings,
  model,
  parseCustomTools,
  parseEnrollment,
  planKeymapFromProbe,
  readProcAncestry,
  resolveGhosttyConfigPath,
  resolvePiAgentDir,
  sha256Hex,
  unquote,
} from "./agent_config.ts";

Deno.test("unquote strips surrounding single and double quotes", () => {
  assertEquals(unquote('"claude"'), "claude");
  assertEquals(unquote("'codex'"), "codex");
  assertEquals(unquote("  kilo  "), "kilo");
});

Deno.test("parseEnrollment reads the flat tools list", () => {
  const text = [
    "swampVersion: 1",
    "tools:",
    "  - claude",
    "  - codex",
    '  - "kilo"',
    "",
    "gitignoreManaged: true",
  ].join("\n");
  assertEquals(parseEnrollment(text), ["claude", "codex", "kilo"]);
});

Deno.test("parseEnrollment returns empty when tools is absent", () => {
  assertEquals(parseEnrollment("swampVersion: 1\ntools: []\n"), []);
});

Deno.test("parseCustomTools reads tool definitions and skills dirs", () => {
  const text = [
    "tools:",
    "  - name: kilo",
    "    skillsDir: .kilo/skills/",
    "    instructionsFile: AGENTS.md",
    "  - name: opencode",
    "    instructionsFile: OPENCODE.md",
  ].join("\n");
  const parsed = parseCustomTools(text);
  assertEquals(parsed.tools, [
    {
      name: "kilo",
      skillsDir: ".kilo/skills/",
      instructionsFile: "AGENTS.md",
    },
    { name: "opencode", skillsDir: null, instructionsFile: "OPENCODE.md" },
  ]);
});

Deno.test("parseCustomTools aggregates gitignoreEntries across tools", () => {
  const text = [
    "tools:",
    "  - name: kilo",
    "    gitignoreEntries: |",
    "      .kilo/cache/",
    "      # a comment",
    "      .kilo/state/",
    "  - name: codex",
    "    gitignoreEntries: |",
    "      .codex/history/",
  ].join("\n");
  const parsed = parseCustomTools(text);
  assertEquals(parsed.gitignoreEntries, [
    ".kilo/cache/",
    ".kilo/state/",
    ".codex/history/",
  ]);
});

Deno.test("parseCustomTools returns empty structures for empty input", () => {
  assertEquals(parseCustomTools(""), { tools: [], gitignoreEntries: [] });
});

// ---------- terminal-keymap helpers ---------------------------------------

Deno.test("classifyTerminal recognizes Kitty-protocol terminals", () => {
  const ghostty = classifyTerminal({ GHOSTTY_RESOURCES_DIR: "/x" }, [], "linux");
  assertEquals(ghostty.outerTerminal, "ghostty");
  assertEquals(ghostty.outerSupportsModifiedEnter, true);
  assertEquals(ghostty.vteTerminal, false);
  assertEquals(ghostty.platform, "linux");

  const vm = classifyTerminal({ TERM_PROGRAM: "WezTerm" }, [], "linux");
  assertEquals(vm.outerTerminal, "wezterm");
  assertEquals(vm.outerSupportsModifiedEnter, true);
});

Deno.test("classifyTerminal flags VTE terminals as unable", () => {
  const c = classifyTerminal({ TERM_PROGRAM: "vte" }, [], "linux");
  assertEquals(c.outerTerminal, "vte-ptyxis");
  assertEquals(c.outerSupportsModifiedEnter, false);
  assertEquals(c.vteTerminal, true);
});

Deno.test("classifyTerminal detects WSL and GNOME", () => {
  const c = classifyTerminal(
    { WSL_DISTRO_NAME: "Ubuntu", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" },
    [],
    "linux",
  );
  assertEquals(c.platform, "wsl");
  assertEquals(c.gnomeDetected, true);
});

Deno.test("classifyTerminal uses ancestry when env is silent", () => {
  const c = classifyTerminal({}, ["bash", "gnome-terminal-"], "linux");
  assertEquals(c.outerTerminal, "gnome-terminal");
  assertEquals(c.vteTerminal, true);
});

Deno.test("classifyTerminal reports unknown for an unclassifiable chain", () => {
  const c = classifyTerminal({ TERM: "dumb" }, ["bash"], "linux");
  assertEquals(c.outerTerminal, "unknown");
  assertEquals(c.outerSupportsModifiedEnter, false);
});

Deno.test("planKeymapFromProbe binds Ctrl+Enter on a capable terminal", () => {
  const plan = planKeymapFromProbe({
    outerTerminal: "ghostty",
    outerSupportsModifiedEnter: true,
    platform: "linux",
    multiplexer: "none",
    preferredSubmitChord: "ctrl+enter",
  });
  assertEquals(plan.strategy, "kitty-protocol");
  assertEquals(plan.submitChord, "ctrl+enter");
  assertEquals(plan.newLineChord, "enter");
  assertEquals(plan.followUpChord, null);
  assertEquals(plan.piKeybindings, {
    "tui.input.submit": "ctrl+enter",
    "tui.input.newLine": "enter",
  });
  assertEquals(plan.ghosttyKeybindLine, "keybind = ctrl+enter=unbind");
});

Deno.test("planKeymapFromProbe falls back to Alt+Enter on VTE", () => {
  const plan = planKeymapFromProbe({
    outerTerminal: "vte-ptyxis",
    outerSupportsModifiedEnter: false,
    platform: "linux",
    multiplexer: "none",
    preferredSubmitChord: "ctrl+enter",
  });
  assertEquals(plan.strategy, "alt-enter-fallback");
  assertEquals(plan.submitChord, "alt+enter");
  assertEquals(plan.followUpChord, "ctrl+q");
  assertEquals(plan.piKeybindings["app.message.followUp"], "ctrl+q");
});

Deno.test("planKeymapFromProbe moves follow-up to Ctrl+Q on Windows/WSL", () => {
  const plan = planKeymapFromProbe({
    outerTerminal: "ghostty",
    outerSupportsModifiedEnter: true,
    platform: "wsl",
    multiplexer: "none",
    preferredSubmitChord: "ctrl+enter",
  });
  assertEquals(plan.strategy, "kitty-protocol");
  assertEquals(plan.followUpChord, "ctrl+q");
});

Deno.test("planKeymapFromProbe warns about tmux and notes herdr", () => {
  const tmux = planKeymapFromProbe({
    outerTerminal: "ghostty",
    outerSupportsModifiedEnter: true,
    platform: "linux",
    multiplexer: "tmux",
    preferredSubmitChord: "ctrl+enter",
  });
  assertEquals(typeof tmux.tmuxWarning, "string");
  assertEquals(tmux.herdrNote, null);

  const herdr = planKeymapFromProbe({
    outerTerminal: "ghostty",
    outerSupportsModifiedEnter: true,
    platform: "linux",
    multiplexer: "herdr",
    preferredSubmitChord: "ctrl+enter",
  });
  assertEquals(herdr.tmuxWarning, null);
  assertEquals(typeof herdr.herdrNote, "string");
});

Deno.test("mergePiKeybindings preserves unrelated keys", () => {
  const { final, changed } = mergePiKeybindings(
    { "tui.select.confirm": "enter", "custom.binding": "x" },
    { "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" },
  );
  assertEquals(changed, true);
  assertEquals(final["tui.select.confirm"], "enter");
  assertEquals(final["custom.binding"], "x");
  assertEquals(final["tui.input.submit"], "ctrl+enter");
});

Deno.test("mergePiKeybindings reports no change when already desired", () => {
  const { changed } = mergePiKeybindings(
    { "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" },
    { "tui.input.submit": "ctrl+enter", "tui.input.newLine": "enter" },
  );
  assertEquals(changed, false);
});

Deno.test("mergePiKeybindings replaces invalid existing content", () => {
  const { final, changed } = mergePiKeybindings(null, {
    "tui.input.submit": "alt+enter",
  });
  assertEquals(changed, true);
  assertEquals(final, { "tui.input.submit": "alt+enter" });
});

Deno.test("resolvePiAgentDir prefers explicit then env then default", () => {
  assertEquals(resolvePiAgentDir("/explicit", { HOME: "/h" }, "linux"), "/explicit");
  assertEquals(
    resolvePiAgentDir(null, { HOME: "/h", PI_CODING_AGENT_DIR: "/env" }, "linux"),
    "/env",
  );
  assertEquals(resolvePiAgentDir(null, { HOME: "/h" }, "linux"), "/h/.pi/agent");
});

Deno.test("resolveGhosttyConfigPath follows the platform default", () => {
  assertEquals(
    resolveGhosttyConfigPath(null, { HOME: "/h" }, "linux"),
    joinPath("/h", ".config", "ghostty", "config.ghostty"),
  );
  assertEquals(
    resolveGhosttyConfigPath(null, { HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"),
    joinPath("/x", "ghostty", "config.ghostty"),
  );
  assertEquals(resolveGhosttyConfigPath("/custom", {}, "linux"), "/custom");
  assertEquals(
    resolveGhosttyConfigPath(null, { LOCALAPPDATA: "C:\\Lo" }, "windows"),
    joinPath("C:\\Lo", "ghostty", "config.ghostty"),
  );
});

Deno.test("mergeGhosttyConfig is idempotent and strips conflicts", () => {
  const first = mergeGhosttyConfig(
    "theme = dark\nkeybind = ctrl+enter=toggle_fullscreen\nfont-family = Old\n",
    "Iosevka",
    "keybind = ctrl+enter=unbind",
  );
  assertEquals(first.removedConflictingKeybinds, 1);
  assertEquals(first.removedFontFamily, 1);
  assertEquals(first.changed, true);
  assertEquals(first.content, "theme = dark\nfont-family = Iosevka\nkeybind = ctrl+enter=unbind\n");

  const second = mergeGhosttyConfig(
    first.content,
    "Iosevka",
    "keybind = ctrl+enter=unbind",
  );
  assertEquals(second.changed, false);
  assertEquals(second.content, first.content);
});

Deno.test("mergeGhosttyConfig creates content when the file is absent", () => {
  const merged = mergeGhosttyConfig(null, "Iosevka", "keybind = ctrl+enter=unbind");
  assertEquals(merged.changed, true);
  assertEquals(merged.content, "font-family = Iosevka\nkeybind = ctrl+enter=unbind\n");
});

Deno.test("desktopEntryDirs orders data home before system dirs", () => {
  const dirs = desktopEntryDirs({ HOME: "/h", XDG_DATA_DIRS: "/a:/b" });
  assertEquals(dirs[0], "/h/.local/share");
  assertEquals(dirs.slice(1), ["/a", "/b"]);
});

Deno.test("sha256Hex hashes UTF-8 text", async () => {
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("basename and dirname split POSIX and Windows paths", () => {
  assertEquals(basename("/a/b/config.ghostty"), "config.ghostty");
  assertEquals(basename("C:\\a\\b\\config"), "config");
  assertEquals(dirname("/a/b/config.ghostty"), "/a/b");
  assertEquals(dirname("C:\\a\\b\\config"), "C:\\a\\b");
});

Deno.test("readProcAncestry reports /proc availability without throwing", async () => {
  const result = await readProcAncestry(Deno.pid);
  assertEquals(Array.isArray(result.names), true);
  // Deno only permits /proc/<pid> reads under --allow-all; when the walk is
  // blocked it must say why instead of looking like a root process.
  if (result.names.length === 0) {
    assertEquals(typeof result.error, "string");
  } else {
    assertEquals(result.error, null);
  }
});

// ---------- terminal-keymap method I/O ------------------------------------

type MethodContext = Parameters<
  typeof model.methods.applyPiKeybindings.execute
>[1];

/** Fake model context that captures writeResource calls instead of persisting. */
function methodContext(): {
  ctx: MethodContext;
  writes: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
} {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const ctx = {
    globalArgs: {},
    writeResource: (spec: string, name: string, data: unknown) => {
      writes.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ name });
    },
    createFileWriter: () => ({
      writeText: () => Promise.resolve({ name: "report-current" }),
    }),
    logger: { info: () => {}, warn: () => {} },
  } as unknown as MethodContext;
  return { ctx, writes };
}

Deno.test("applyPiKeybindings writes idempotently to a temp agent dir", async () => {
  const dir = await Deno.makeTempDir();
  const { ctx, writes } = methodContext();
  try {
    await model.methods.applyPiKeybindings.execute(
      { submitChord: "ctrl+enter", newLineChord: "enter", agentDir: dir },
      ctx,
    );
    const path = joinPath(dir, "keybindings.json");
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      "tui.input.submit": "ctrl+enter",
      "tui.input.newLine": "enter",
    });
    assertEquals(writes[0].spec, "piKeybindings");
    assertEquals(writes[0].data.changed, true);
    assertEquals(writes[0].data.existed, false);

    await model.methods.applyPiKeybindings.execute(
      { submitChord: "ctrl+enter", newLineChord: "enter", agentDir: dir },
      ctx,
    );
    assertEquals(writes[1].data.changed, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyPiKeybindings preserves existing custom bindings", async () => {
  const dir = await Deno.makeTempDir();
  const { ctx } = methodContext();
  const path = joinPath(dir, "keybindings.json");
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({ "tui.select.confirm": "enter", "custom.binding": "x" }),
    );
    await model.methods.applyPiKeybindings.execute(
      {
        submitChord: "alt+enter",
        newLineChord: "enter",
        followUpChord: "ctrl+q",
        agentDir: dir,
      },
      ctx,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      "tui.select.confirm": "enter",
      "custom.binding": "x",
      "tui.input.submit": "alt+enter",
      "tui.input.newLine": "enter",
      "app.message.followUp": "ctrl+q",
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("applyGhosttyConfig merges into a temp config idempotently", async () => {
  const dir = await Deno.makeTempDir();
  const { ctx, writes } = methodContext();
  const path = joinPath(dir, "config.ghostty");
  try {
    await Deno.writeTextFile(
      path,
      "theme = dark\nkeybind = ctrl+enter=toggle_fullscreen\n",
    );
    await model.methods.applyGhosttyConfig.execute(
      {
        keybindLine: "keybind = ctrl+enter=unbind",
        fontFamily: "Iosevka",
        configPath: path,
      },
      ctx,
    );
    assertEquals(
      await Deno.readTextFile(path),
      "theme = dark\nfont-family = Iosevka\nkeybind = ctrl+enter=unbind\n",
    );
    assertEquals(writes[0].spec, "ghosttyConfig");
    assertEquals(writes[0].data.removedConflictingKeybinds, 1);
    assertEquals(writes[0].data.changed, true);

    await model.methods.applyGhosttyConfig.execute(
      {
        keybindLine: "keybind = ctrl+enter=unbind",
        fontFamily: "Iosevka",
        configPath: path,
      },
      ctx,
    );
    assertEquals(writes[1].data.changed, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
