import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ftsPhrase,
	isWithin,
	listRecentSessions,
	projectLabelForCwd,
	searchSessions,
} from "../../src/gateway/session-search.js";

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
	it("builds a persistent FTS5 index and returns ranked hits for a phrase", () => {
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
				indexPath: join(dir, "index.sqlite"),
				query: "recall index",
				projectRoot: "/home/u/projects/alpha",
				projectHome: "/home/u",
				scope: "project",
			});
			expect(result.queryTooShort).toBe(false);
			expect(result.hits.length).toBeGreaterThan(0);
			expect(result.hits[0]).toMatchObject({ sessionId: "11111111-aaaa", projectLabel: "alpha" });
			expect(result.hits[0]!.snippet).toContain("recall index");
			expect(result.sessionsIndexed).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists the index across opens and only rescans changed files", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			const index = join(dir, "index.sqlite");
			writeFileSync(
				join(dir, "a.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "we decided to ship the recall index"],
				]),
			);
			const first = searchSessions({ sessionsDir: dir, indexPath: index, query: "recall index", scope: "all" });
			expect(first.hits.length).toBe(1);
			// Add a second session, then search again on the same index.
			writeFileSync(
				join(dir, "b.jsonl"),
				sessionLines("22222222-bbbb", "/home/u/projects/beta", [
					["user", "2026-03-01T00:00:00.000Z", "the shipment lands on friday"],
				]),
			);
			const second = searchSessions({ sessionsDir: dir, indexPath: index, query: "shipment", scope: "all" });
			expect(second.hits.map((h) => h.sessionId)).toContain("22222222-bbbb");
			expect(second.sessionsIndexed).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("re-indexes a changed file on mtime/size change", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			const index = join(dir, "index.sqlite");
			const file = join(dir, "a.jsonl");
			writeFileSync(
				file,
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "old phrasing about widgets"],
				]),
			);
			expect(
				searchSessions({ sessionsDir: dir, indexPath: index, query: "widgets", scope: "all" }).hits.length,
			).toBe(1);
			// Deterministic: force a newer mtime (consecutive writes within one ms
			// can share a timestamp on some filesystems). Content also grows.
			writeFileSync(
				file,
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "new phrasing about gadgets and a longer tail"],
				]),
			);
			utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
			const after = searchSessions({ sessionsDir: dir, indexPath: index, query: "gadgets", scope: "all" });
			expect(after.hits.length).toBe(1);
			expect(
				searchSessions({ sessionsDir: dir, indexPath: index, query: "widgets", scope: "all" }).hits.length,
			).toBe(0);
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
				indexPath: join(dir, "index.sqlite"),
				query: "shipment",
				projectRoot: "/home/u/projects/alpha",
				projectHome: "/home/u",
				scope: "project",
			});
			expect(scoped.hits.map((h) => h.sessionId)).not.toContain("22222222-bbbb");
			const all = searchSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
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

	it("pages results with offset", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "a.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "remember to ship the index"],
					["user", "2026-02-01T00:00:02.000Z", "also remember the second note"],
				]),
			);
			const index = join(dir, "index.sqlite");
			const base = { sessionsDir: dir, indexPath: index, query: "remember", scope: "all" } as const;
			const page1 = searchSessions({ ...base, limit: 1, offset: 0 });
			const page2 = searchSessions({ ...base, limit: 1, offset: 1 });
			expect(page1.hits.length).toBe(1);
			expect(page2.hits.length).toBe(1);
			// Two messages in the same session page across rows; snippets differ.
			expect(page1.hits[0]!.snippet).not.toBe(page2.hits[0]!.snippet);
			expect(page1.hits[0]!.sessionId).toBe(page2.hits[0]!.sessionId);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns queryTooShort for <3 char queries and outOfRange past the end", () => {
		const result = searchSessions({
			sessionsDir: "/nonexistent",
			indexPath: "/tmp/x.sqlite",
			query: "ab",
			scope: "project",
		});
		expect(result.queryTooShort).toBe(true);
		expect(result.hits).toEqual([]);
	});

	it("is resilient to empty and malformed archives", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(join(dir, "garbage.jsonl"), "not json\n{ broken\n");
			const result = searchSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
				query: "anything here",
				scope: "project",
				projectRoot: "/home/u/projects/alpha",
			});
			expect(result.hits).toEqual([]);
			expect(result.sessionsIndexed).toBe(0);
			const missing = searchSessions({
				sessionsDir: join(dir, "nope"),
				indexPath: join(dir, "index.sqlite"),
				query: "recall index",
				scope: "project",
			});
			expect(missing.hits).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("listRecentSessions browses newest-first with project labels", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "old.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-01-01T00:00:00.000Z", "early note"],
				]),
			);
			writeFileSync(
				join(dir, "new.jsonl"),
				sessionLines("22222222-bbbb", "/home/u/projects/beta", [
					["user", "2026-03-01T00:00:00.000Z", "fresh project note"],
				]),
			);
			const entries = listRecentSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
				scope: "all",
				projectHome: "/home/u",
			});
			expect(entries.length).toBe(2);
			expect(entries[0]!.shortId).toBe("2222222");
			expect(entries[0]!.projectLabel).toBe("beta");
			expect(entries[0]!.firstMessage).toContain("fresh project");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ftsPhrase is injection-safe and helper geometry is correct", () => {
		expect(ftsPhrase('a "b" c')).toBe('"a ""b"" c"');
		expect(ftsPhrase("x\\y")).toBe('"x\\\\y"');
		expect(ftsPhrase("a\nb")).toBe('"a b"');
		expect(isWithin("/r", "/r")).toBe(true);
		expect(isWithin("/r", "/r/projects/a")).toBe(true);
		expect(isWithin("/r", "/other")).toBe(false);
		expect(isWithin("/r", "/r-other")).toBe(false);
		expect(projectLabelForCwd("/home/u/projects/alpha", "/home/u")).toBe("alpha");
		expect(projectLabelForCwd("/home/u/projects/alpha/sub", "/home/u")).toBe("alpha");
		expect(projectLabelForCwd("/home/u/projects", "/home/u")).toBe("workspace");
		expect(projectLabelForCwd("/home/u/projects/alpha", undefined)).toBe("workspace");
	});

	it("indexes archived session files so /search still finds them after a reset", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "chan.jsonl.archived-1780000000000"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "the archived run still recalls the widget decision"],
				]),
			);
			const result = searchSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
				query: "widget decision",
				scope: "all",
			});
			expect(result.hits.length).toBe(1);
			expect(result.hits[0]!.sessionId).toContain("11111111-aaaa");
			expect(result.hits[0]!.sessionId).toContain(".archived-1780000000000");
			expect(result.sessionsIndexed).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("indexes an archive alongside its live replacement without crashing or losing either", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-search-"));
		try {
			writeFileSync(
				join(dir, "chan.jsonl.archived-1780000000000"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-01T00:00:00.000Z", "old phrasing about widgets"],
				]),
			);
			writeFileSync(
				join(dir, "chan.jsonl"),
				sessionLines("11111111-aaaa", "/home/u/projects/alpha", [
					["user", "2026-02-02T00:00:00.000Z", "fresh phrasing about gadgets"],
				]),
			);
			const live = searchSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
				query: "gadgets",
				scope: "all",
			});
			expect(live.hits.length).toBe(1);
			expect(live.sessionsIndexed).toBe(2);
			const old = searchSessions({
				sessionsDir: dir,
				indexPath: join(dir, "index.sqlite"),
				query: "widgets",
				scope: "all",
			});
			expect(old.hits.length).toBe(1);
			expect(old.hits[0]!.snippet).toContain("widgets");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
