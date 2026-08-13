import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";
import {
	createRecallExtension,
	defaultRecallPaths,
	formatRecallRecent,
	formatRecallResult,
} from "../../src/extensions/recall/index.js";
import type { SearchResult } from "../../src/gateway/session-search.js";

function fakePi() {
	const tools: Array<{ name: string; execute?: (id: string, p: unknown) => Promise<unknown> }> = [];
	const pi = {
		registerTool: (tool: { name: string; execute: (id: string, p: unknown) => Promise<unknown> }) => {
			tools.push(tool);
		},
	};
	return { pi: fromAny<ExtensionAPI, unknown>(pi), tools };
}

function header(id: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00Z", cwd });
}
function sessionLines(id: string, cwd: string, turns: Array<[string, string, string]>): string {
	const lines = [
		header(id, cwd),
		...turns.map(([role, ts, text]) =>
			JSON.stringify({
				type: "message",
				id: `${id}-${text.slice(0, 6)}`,
				timestamp: ts,
				message: { role, content: [{ type: "text", text }] },
			}),
		),
	];
	return `${lines.join("\n")}\n`;
}
function seed(dir: string): void {
	writeFileSync(
		join(dir, "a.jsonl"),
		sessionLines("aaaaaaaa-aaaa", "/home/u/projects/alpha", [
			["user", "2026-02-01T00:00:00.000Z", "we decided to ship the recall index in august"],
		]),
	);
	writeFileSync(
		join(dir, "b.jsonl"),
		sessionLines("bbbbbbbb-bbbb", "/home/u/projects/beta", [
			["user", "2026-03-01T00:00:00.000Z", "the shipment lands on friday"],
		]),
	);
}
function deps(dir: string, extra: Record<string, unknown> = {}) {
	return { sessionsDir: dir, indexPath: join(dir, "index.sqlite"), projectHome: "/home/u", ...extra };
}

describe("recall extension", () => {
	it("registers a recall tool", () => {
		const { pi, tools } = fakePi();
		createRecallExtension(deps("/tmp/s"))(pi);
		expect(tools.some((t) => t.name === "recall")).toBe(true);
	});

	it("executes a query and returns project-scoped snippets", async () => {
		const { pi, tools } = fakePi();
		const dir = mkdtempSync(join(tmpdir(), "axml-rc-"));
		try {
			seed(dir);
			createRecallExtension(deps(dir, { projectRoot: "/home/u/projects/alpha" }))(pi);
			const tool = tools.find((t) => t.name === "recall")!;
			const out = fromAny<
				{
					content: Array<{ text: string }>;
				},
				unknown
			>(await tool.execute!("1", { action: "query", query: "recall index" }));
			expect(out.content[0]!.text).toContain("aaaaaaaa-aaaa".slice(0, 7));
			expect(out.content[0]!.text).not.toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("all=true crosses projects and labels by project", async () => {
		const { pi, tools } = fakePi();
		const dir = mkdtempSync(join(tmpdir(), "axml-rc-"));
		try {
			seed(dir);
			createRecallExtension(deps(dir, { projectRoot: "/home/u/projects/alpha" }))(pi);
			const tool = tools.find((t) => t.name === "recall")!;
			const out = fromAny<
				{
					content: Array<{ text: string }>;
				},
				unknown
			>(await tool.execute!("1", { action: "query", query: "shipment", all: true }));
			expect(out.content[0]!.text).toContain("[beta]");
			expect(out.content[0]!.text).toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("action=recent browses newest sessions", async () => {
		const { pi, tools } = fakePi();
		const dir = mkdtempSync(join(tmpdir(), "axml-rc-"));
		try {
			seed(dir);
			createRecallExtension(deps(dir))(pi);
			const tool = tools.find((t) => t.name === "recall")!;
			const out = fromAny<
				{
					content: Array<{ text: string }>;
				},
				unknown
			>(await tool.execute!("1", { action: "recent", all: true }));
			expect(out.content[0]!.text).toContain("recent sessions");
			expect(out.content[0]!.text).toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("handles empty query, too-short, and no-match", async () => {
		const { pi, tools } = fakePi();
		const dir = mkdtempSync(join(tmpdir(), "axml-rc-"));
		try {
			seed(dir);
			createRecallExtension(deps(dir))(pi);
			const tool = tools.find((t) => t.name === "recall")!;
			expect(
				fromAny<{ content: Array<{ text: string }> }, unknown>(await tool.execute!("1", { action: "query" }))
					.content[0]!.text,
			).toContain("requires a query");
			expect(
				fromAny<{ content: Array<{ text: string }> }, unknown>(await tool.execute!("1", { query: "ab" }))
					.content[0]!.text,
			).toContain("too short");
			expect(
				fromAny<{ content: Array<{ text: string }> }, unknown>(await tool.execute!("1", { query: "zzz-no-such" }))
					.content[0]!.text,
			).toContain("no past-session matches");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("formatRecallRecent renders entries and empty state", () => {
		expect(formatRecallRecent([])).toContain("no recent");
		expect(
			formatRecallResult(
				fromPartial<SearchResult>({
					hits: [],
					sessionsIndexed: 0,
					sessionsMatched: 0,
					queryTooShort: false,
					outOfRange: false,
				}),
			),
		).toContain("no past-session matches");
	});

	it("defaultRecallPaths maps to the agent sessions dir and axiom search index", () => {
		const paths = defaultRecallPaths();
		expect(paths.indexPath).toContain("search/session-recall.sqlite");
		expect(paths.sessionsDir).toContain("sessions");
	});
});
