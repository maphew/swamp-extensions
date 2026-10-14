/**
 * Unit tests for the pure helpers in {@link ./kilo_project.ts}.
 *
 * @module
 */

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { redact, stripJsonComments } from "./kilo_project.ts";

Deno.test("stripJsonComments removes line and block comments", () => {
  const src = [
    "{",
    "  // a line comment",
    '  "a": 1, /* inline */',
    "  /* multi",
    "     line */",
    '  "b": 2',
    "}",
  ].join("\n");
  assertEquals(JSON.parse(stripJsonComments(src)), { a: 1, b: 2 });
});

Deno.test("stripJsonComments preserves // inside string values", () => {
  const src = '{ "url": "https://example.com/path", "n": 1 } // trailing';
  assertEquals(JSON.parse(stripJsonComments(src)), {
    url: "https://example.com/path",
    n: 1,
  });
});

Deno.test("stripJsonComments preserves escaped quotes in strings", () => {
  const src = '{ "quote": "a \\" // b", /* c */ "n": 2 }';
  assertEquals(JSON.parse(stripJsonComments(src)), {
    quote: 'a " // b',
    n: 2,
  });
});

Deno.test("redact replaces secret-looking keys recursively", () => {
  const input = {
    apiKey: "abc",
    token: "def",
    password: "hunter2",
    authorization: "Bearer x",
    privateKey: "-----BEGIN",
    nested: { secret: "s", keep: 1, headers: { A: "b" } },
    list: [{ credential: "c" }, { keep: true }],
    plain: "visible",
  };
  assertEquals(redact(input), {
    apiKey: "[redacted]",
    token: "[redacted]",
    password: "[redacted]",
    authorization: "[redacted]",
    privateKey: "[redacted]",
    nested: { secret: "[redacted]", keep: 1, headers: "[redacted]" },
    list: [{ credential: "[redacted]" }, { keep: true }],
    plain: "visible",
  });
});

Deno.test("redact passes through primitives and null unchanged", () => {
  assertEquals(redact("x"), "x");
  assertEquals(redact(3), 3);
  assertEquals(redact(null), null);
  assertEquals(redact(true), true);
});

Deno.test("redact is case-insensitive on key names", () => {
  assertEquals(redact({ API_KEY: "x", Token: "y" }), {
    API_KEY: "[redacted]",
    Token: "[redacted]",
  });
});
