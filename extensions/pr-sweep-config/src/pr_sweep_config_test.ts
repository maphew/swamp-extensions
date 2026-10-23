/**
 * Unit tests for the pure helpers in {@link ./pr_sweep_config.ts}.
 *
 * @module
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { deriveId, renderConfigSummary } from "./pr_sweep_config.ts";

Deno.test("deriveId lowercases and collapses non-alphanumerics", () => {
  assertEquals(deriveId("Kilocode"), "kilocode");
  assertEquals(deriveId("Kilo-Org / kilocode"), "kilo-org-kilocode");
  assertEquals(deriveId("  My Repo!! "), "my-repo");
});

Deno.test("deriveId trims leading and trailing dashes", () => {
  assertEquals(deriveId("--edge--"), "edge");
  assertEquals(deriveId("a.b_c"), "a-b-c");
});

Deno.test("renderConfigSummary reports an empty config", () => {
  const md = renderConfigSummary({ repoPairs: [] });
  assertStringIncludes(md, "# PR Sweep Configuration");
  assertStringIncludes(md, "No repository pairs configured.");
});

Deno.test("renderConfigSummary renders a table row per pair", () => {
  const md = renderConfigSummary({
    repoPairs: [
      {
        id: "kilocode",
        name: "kilocode",
        upstreamRepo: "Kilo-Org/kilocode",
        forkRepo: "maphew/kilocode",
        workdir: "/work/kilocode",
        enabled: true,
        agent: "kilo",
        model: "zai-coding-plan/glm-5.3",
        mainBranch: "main",
        swampRepoDir: ".",
      },
      {
        id: "other",
        name: "other",
        upstreamRepo: "up/other",
        forkRepo: "maphew/other",
        workdir: "/work/other",
        enabled: false,
        agent: "codex",
        model: "",
        mainBranch: "develop",
        swampRepoDir: ".",
      },
    ],
  });
  assertStringIncludes(
    md,
    "| ✓ | kilocode | Kilo-Org/kilocode | maphew/kilocode | /work/kilocode | kilo | zai-coding-plan/glm-5.3 |",
  );
  assertStringIncludes(
    md,
    "| ✗ | other | up/other | maphew/other | /work/other | codex | (default) |",
  );
});
