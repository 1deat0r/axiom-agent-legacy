// Tests for the dash-safe argv pre-processor.
//
// parseArgs rejects a dash-prefixed value passed as a separate token, but the
// bridge passes SKILL.md content that begins with "---" exactly that way.
// parseArgsSafe joins "--opt value" into "--opt=value" to remove the
// ambiguity.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgsSafe } from "../src/cli/parse_args.ts";

test("joins a dash-prefixed value for a string option", () => {
  const { values } = parseArgsSafe(
    { options: { content: { type: "string" } } },
    ["--content", "---\nname: foo\nbody"],
  );
  assert.equal(values.content, "---\nname: foo\nbody");
});

test("passes ordinary values through unchanged", () => {
  const { values } = parseArgsSafe(
    { options: { name: { type: "string" }, content: { type: "string" } } },
    ["--name", "foo", "--content", "plain"],
  );
  assert.equal(values.name, "foo");
  assert.equal(values.content, "plain");
});

test("leaves boolean options (no value) alone", () => {
  const { values } = parseArgsSafe({ options: { write: { type: "boolean" } } }, ["--write"]);
  assert.equal(values.write, true);
});

test("value options with an empty value still bind", () => {
  const { values } = parseArgsSafe(
    { options: { category: { type: "string", default: "" } } },
    ["--category", ""],
  );
  assert.equal(values.category, "");
});
