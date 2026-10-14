/**
 * Unit tests for the pure helpers in {@link ./agent_config.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  parseCustomTools,
  parseEnrollment,
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
