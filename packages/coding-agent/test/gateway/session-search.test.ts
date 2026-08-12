import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ftsPhrase, isWithin, projectLabelForCwd, searchSessions } from "../../src/gateway/session-search.js";

function HEADER(id: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
}

function sessionLines(id: string, cwd: string, rows: Array<[string, string, string]>): string {
	const lines = [
		HEADER(id, cwd),
		...rows.map(([role, ts, text]) =>
			JSON.stringify({
				type: "message",
				id: `${id}-${role}`,
				parentId: null,
				timestamp: ts,
				message: { role, content: [{ type: "text", text }] },
			}),
		),
	];
	return `${lines.join("\n")}\n`;
}

describe("session-search module", () => {
	it("builds an FTS5 index and returns ranked hits for a phrase", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "a.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "we decided to ship the recall index in august"],
					["assistant", "2026-02-01T00:00:01.000Z", "agreed, the FTS5 index is the way"],
				]),
			);
			writeFileSync(
				join(dir, "b.jsonl"),
				sessionLines("22222222-bbbb", "/home/u/projects/beta", [
					["user", "2026-03-01T00:00:00.000Z", "timing discussion about a totally different thing"],
				]),
			);
			const result = searchSessions({
				sessionsDir: dir,
				query: "recall index",
				projectRoot: "/home/u/projects/alpha",
				projectHome: "/home/u",
				scope: "project",
			});
			expect(result.queryTooShort).toBe(false);
			expect(result.hits.length).toBeGreaterThan(0);
			expect(result.hits[0]).toMatchObject({ sessionId: "11111111-aaaa", projectLabel: "alpha" });
			expect(result.hits[0]!.snippet).toContain("recall index");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scopes to the anchored project: beta is excluded without --all", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "a.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "the shipment lands on friday"],
				]),
			);
			writeFileSync(
				join(dir, "b.jsonl"),
				sessionLines("22222222-bbbb", "/home/u/projects/beta", [
					["user", "2026-03-01T00:00:00.000Z", "the shipment lands on friday too"],
				]),
			);
			const scoped = searchSessions({
				sessionsDir: dir,
				query: "shipment",
				projectRoot: "/home/u/projects/alpha",
				projectHome: "/home/u",
				scope: "project",
			});
			expect(scoped.hits.map((h) => h.sessionId)).not.toContain("22222222-bbbb");
			expect(scoped.hits.map((h) => h.sessionId)).toContain("11111111-aaaa");
			// --all crosses, labeled by project
			const all = searchSessions({
				sessionsDir: dir,
				query: "shipment",
				projectRoot: "/home/u/projects/alpha",
				projectHome: "/home/u",
				scope: "all",
			});
			expect(all.hits.map((h) => h.projectLabel).sort()).toEqual(["alpha", "beta"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns queryTooShort for <3 char queries", () => {
		const result = searchSessions({ sessionsDir: "/nonexistent", query: "ab", scope: "project" });
		expect(result.queryTooShort).toBe(true);
		expect(result.hits).toEqual([]);
	});

	it("is resilient to empty and malformed archives", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(join(dir, "garbage.jsonl"), "not json\n{ broken\n");
			const result = searchSessions({
				sessionsDir: dir,
				query: "anything here",
				scope: "project",
				projectRoot: "/home/u/projects/alpha",
			});
			expect(result.hits).toEqual([]);
			expect(result.sessionsScanned).toBe(0);
			// missing dir
			const missing = searchSessions({ sessionsDir: join(dir, "nope"), query: "recall index", scope: "project" });
			expect(missing.hits).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ftsPhrase is injection-safe", () => {
		expect(ftsPhrase('a "b" c')).toBe('"a ""b"" c"');
		expect(ftsPhrase("x\\y")).toBe('"x\\\\y"');
		expect(ftsPhrase("a\nb")).toBe('"a b"');
	});

	it("isWithin and projectLabelForCwd", () => {
		expect(isWithin("/r", "/r")).toBe(true);
		expect(isWithin("/r", "/r/projects/a")).toBe(true);
		expect(isWithin("/r", "/other")).toBe(false);
		expect(isWithin("/r", "/r-other")).toBe(false);
		expect(projectLabelForCwd("/home/u/projects/alpha", "/home/u")).toBe("alpha");
		expect(projectLabelForCwd("/home/u/projects/alpha/sub", "/home/u")).toBe("alpha");
		expect(projectLabelForCwd("/home/u/projects", "/home/u")).toBe("workspace");
		expect(projectLabelForCwd("/home/u/elsewhere", "/home/u")).toBe("workspace");
		expect(projectLabelForCwd("/home/u/projects/alpha", undefined)).toBe("workspace");
	});
});
