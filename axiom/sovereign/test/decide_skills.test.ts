// Tests for the store-first skill decision layer.
// TypeScript port of 3v0/tests/test_decide_skills.py.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decideSkill } from "../src/decide_skills.ts";
import { ABSORBED, RETRACTED, SkillStore } from "../src/skills.ts";

function makeStore(): { path: string; store: SkillStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-decide-skills-"));
  const path = join(dir, "skills.json");
  return { path, store: new SkillStore(path) };
}

test("skill update plain", () => {
  const { store } = makeStore();
  const r = decideSkill(store, {
    action: "skill_update",
    name: "my-skill",
    content: "---\nname: my-skill\n---\nbody v2\n",
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "skill_update");
  assert.equal(r.skill!.action, "edit");
  assert.deepEqual(r.superseded_ids, []);
  assert.notEqual(store.latestActive("my-skill"), null);
  assert.equal(store.latestActive("my-skill")!.content, "---\nname: my-skill\n---\nbody v2");
});

test("skill update supersedes previous version", () => {
  const { store } = makeStore();
  const old = store.add("my-skill", "create", "test", "---\nname: my-skill\n---\nbody v1\n");
  const r = decideSkill(store, { action: "skill_update", name: "my-skill", content: "v2" });
  assert.deepEqual(r.superseded_ids, [old.id]);
  assert.equal(old.active, false);
  assert.deepEqual(r.chain!.map((v) => v.content), ["---\nname: my-skill\n---\nbody v1\n", "v2"]);
});

test("skill update missing name refused", () => {
  const { store } = makeStore();
  const r = decideSkill(store, { action: "skill_update", content: "x" });
  assert.ok(r.error !== undefined);
});

test("skill update missing content refused", () => {
  const { store } = makeStore();
  const r = decideSkill(store, { action: "skill_update", name: "my-skill" });
  assert.ok(r.error !== undefined);
  assert.deepEqual(store.active(), []);
});

test("skill retract", () => {
  const { store } = makeStore();
  const v = store.add("my-skill", "create", "test", "---\nname: my-skill\n---\nbody v1\n");
  const r = decideSkill(store, { action: "skill_retract", name: "my-skill" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "skill_retract");
  assert.equal(v.active, false);
  assert.equal(v.superseded_by, RETRACTED);
  assert.equal(store.latestActive("my-skill"), null);
});

test("skill retract unknown name refused", () => {
  const { store } = makeStore();
  const r = decideSkill(store, { action: "skill_retract", name: "nope" });
  assert.ok(r.error !== undefined);
});

test("skill retract missing name refused", () => {
  const { store } = makeStore();
  const r = decideSkill(store, { action: "skill_retract" });
  assert.ok(r.error !== undefined);
});

test("skill absorb", () => {
  const { store } = makeStore();
  const v = store.add("my-skill", "create", "test", "---\nname: my-skill\n---\nbody v1\n");
  const r = decideSkill(store, { action: "skill_absorb", name: "my-skill", absorbed_into: "umbrella" });
  assert.equal(r.ok, true);
  assert.equal(r.action, "skill_absorb");
  assert.equal(r.absorbed_into, "umbrella");
  assert.equal(v.active, false);
  assert.equal(v.superseded_by, ABSORBED);
  assert.equal(v.absorbed_into, "umbrella");
  assert.deepEqual(store.absorbedBy("umbrella"), ["my-skill"]);
});

test("skill absorb missing umbrella refused", () => {
  const { store } = makeStore();
  store.add("my-skill", "create", "test", "---\nname: my-skill\n---\nbody v1\n");
  const r = decideSkill(store, { action: "skill_absorb", name: "my-skill" });
  assert.ok(r.error !== undefined);
  assert.notEqual(store.latestActive("my-skill"), null);
});

test("unknown action refused", () => {
  const { store } = makeStore();
  const r = decideSkill(store, { action: "frobnicate", name: "x" });
  assert.ok(r.error !== undefined);
});

test("dry run does not persist", () => {
  const { path, store } = makeStore();
  store.add("my-skill", "create", "test", "---\nname: my-skill\n---\nbody v1\n");
  decideSkill(store, { action: "skill_update", name: "my-skill", content: "no persist" }, false);
  const s2 = new SkillStore(path);
  assert.ok(!s2.versions("my-skill").some((v) => v.content === "no persist"));
});
