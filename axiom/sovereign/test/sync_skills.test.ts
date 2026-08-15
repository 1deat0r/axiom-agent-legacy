// Tests for skill-store <-> profile reconciliation.
// TypeScript port of 3v0/tests/test_sync_skills.py.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findSkillMd } from "../src/skill_io.ts";
import { SkillStore } from "../src/skills.ts";
import { isCleanReport, syncSkills } from "../src/sync_skills.ts";

function mkSkill(skillsDir: string, name: string, content: string, category = ""): void {
  const target = category ? join(skillsDir, category, name) : join(skillsDir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), content, "utf8");
}

function makeEnv(): { dir: string; skillsDir: string; store: SkillStore } {
  const dir = mkdtempSync(join(tmpdir(), "axiom-sync-skills-"));
  const skillsDir = join(dir, "skills");
  mkdirSync(skillsDir);
  const store = new SkillStore(join(dir, "skills.json"));
  return { dir, skillsDir, store };
}

test("no drift reports clean", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\nbody\n");
  store.add("foo", "create", "profile-import", "---\nname: foo\nbody\n");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), false);
  assert.equal(isCleanReport(r), true);
});

test("imports unseen agent skill", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\n");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.ok(r.imported.includes("foo"));
  assert.equal(store.latestActive("foo")!.content, "---\nname: foo\n");
  assert.equal(store.latestActive("foo")!.source, "profile-import");
});

test("ignores non agent skill", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "bundled", "---\nname: bundled\n");
  const r = syncSkills(store, skillsDir, new Set(), true);
  assert.equal(isCleanReport(r), true);
  assert.deepEqual(store.allVersions(), []);
});

test("heals bridge missed edit", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\nnewer body\n");
  store.add("foo", "create", "profile-import", "---\nname: foo\nolder\n");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.ok(r.edited.includes("foo"));
  const head = store.latestActive("foo")!;
  assert.equal(head.action, "edit");
  assert.equal(head.content, "---\nname: foo\nnewer body\n");
  assert.equal(store.history("foo").length, 2);
});

test("edit is idempotent", () => {
  const { skillsDir, store } = makeEnv();
  const content = "---\nname: foo\n";
  mkSkill(skillsDir, "foo", content);
  store.add("foo", "create", "profile-import", content);
  const r1 = syncSkills(store, skillsDir, new Set(["foo"]), true);
  const r2 = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.equal(isCleanReport(r1), true);
  assert.equal(isCleanReport(r2), true);
  assert.equal(store.versions("foo").length, 1);
});

test("drops decommissioned skill", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\n");
  store.add("foo", "create", "a", "---\nname: foo\n");
  store.retract("foo", "test");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.ok(r.dropped.includes("foo"));
  assert.equal(findSkillMd(skillsDir, "foo"), null);
});

test("decommissioned absent is noop", () => {
  const { skillsDir, store } = makeEnv();
  store.add("foo", "create", "a", "x");
  store.retract("foo");
  const r = syncSkills(store, skillsDir, new Set(), true);
  assert.equal(isCleanReport(r), true);
});

test("exports store only skill", () => {
  const { skillsDir, store } = makeEnv();
  store.add("foo", "create", "a", "---\nname: foo\nbody\n", "dev");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.ok(r.exported.includes("foo"));
  const sf = findSkillMd(skillsDir, "foo");
  assert.notEqual(sf, null);
  assert.equal(sf!.content, "---\nname: foo\nbody\n");
  assert.equal(sf!.category, "dev");
});

test("unresolved contentless head", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\nlive\n");
  store.add("foo", "create", "a", "---\nname: foo\nold\n");
  store.add("foo", "patch", "a", "", "", "", "patch 'x' -> 'y'");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true);
  assert.ok(r.unresolved.includes("foo"));
  assert.equal(findSkillMd(skillsDir, "foo")!.content, "---\nname: foo\nlive\n");
});

test("folds curator state", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\n");
  store.add("foo", "create", "a", "---\nname: foo\n");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true, { foo: "stale" });
  assert.ok(r.state_changes.includes("foo: active->stale"));
  assert.equal(store.state("foo"), "stale");
  assert.deepEqual(r.imported, []);
  assert.deepEqual(r.edited, []);
});

test("state fold is idempotent", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\n");
  store.add("foo", "create", "a", "---\nname: foo\n");
  const cs = { foo: "stale" };
  syncSkills(store, skillsDir, new Set(["foo"]), true, cs);
  const r2 = syncSkills(store, skillsDir, new Set(["foo"]), true, cs);
  assert.deepEqual(r2.state_changes, []);
  assert.equal(isCleanReport(r2), true);
});

test("archived skill not exported", () => {
  const { skillsDir, store } = makeEnv();
  store.add("foo", "create", "a", "---\nname: foo\nbody\n", "dev");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true, { foo: "archived" });
  assert.deepEqual(r.exported, []);
  assert.ok(r.state_changes.includes("foo: active->archived"));
  assert.equal(findSkillMd(skillsDir, "foo"), null);
});

test("archive dir excluded from live index", () => {
  const { skillsDir, store } = makeEnv();
  mkSkill(skillsDir, "foo", "---\nname: foo\n", ".archive");
  store.add("foo", "create", "a", "---\nname: foo\n");
  const r = syncSkills(store, skillsDir, new Set(["foo"]), true, { foo: "archived" });
  assert.deepEqual(r.exported, []);
  assert.deepEqual(r.imported, []);
  assert.equal(store.state("foo"), "archived");
});
