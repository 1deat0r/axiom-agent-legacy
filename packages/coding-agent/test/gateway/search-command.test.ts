import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSearchArgs, renderSearchReply } from "../../src/gateway/commands/search.js";
import { renderSessionsReply } from "../../src/gateway/commands/sessions.js";
import type { GatewayCommandContext } from "../../src/gateway/types.js";

const PROJECT_HOME = "/home/u";
const ALPHA = join(PROJECT_HOME, "projects", "alpha");
const BETA = join(PROJECT_HOME, "projects", "beta");

function header(id: string, cwd: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
}
function sessionLines(id: string, cwd: string, turns: Array<[string, string, string]>): string {
	const lines = [
		header(id, cwd),
		...turns.map(([role, ts, text]) =>
			JSON.stringify({
				type: "message",
				id: `${id}-${text.slice(0, 6)}`,
				parentId: null,
				timestamp: ts,
				message: { role, content: [{ type: "text", text }] },
			}),
		),
	];
	return `${lines.join("\n")}\n`;
}

function writeSessions(dir: string): void {
	writeFileSync(
		join(dir, "a.jsonl"),
		sessionLines("aaaaaaaa-aaaa", ALPHA, [
			["user", "2026-02-01T00:00:00.000Z", "we decided to ship the recall index in august"],
			["assistant", "2026-02-01T00:00:01.000Z", "agreed, FTS5 is the way"],
		]),
	);
	writeFileSync(
		join(dir, "b.jsonl"),
		sessionLines("bbbbbbbb-bbbb", BETA, [["user", "2026-03-01T00:00:00.000Z", "the shipment lands on friday"]]),
	);
}

function ctx(sessionsDir: string, extra: Partial<GatewayCommandContext> = {}): GatewayCommandContext {
	return {
		profile: "default",
		axiomHomeDir: "/tmp/ax",
		projectHome: PROJECT_HOME,
		sessionsDir,
		searchIndexPath: join(sessionsDir, "index.sqlite"),
		...extra,
	};
}

function argv(text: string): string[] {
	return text.split(" ");
}

describe("/search command", () => {
	it("parseSearchArgs", () => {
		expect(parseSearchArgs(["recall", "index"])).toEqual({ query: "recall index", all: false, limit: 8, offset: 0 });
		expect(parseSearchArgs(["--all", "shipment"])).toEqual({ query: "shipment", all: true, limit: 8, offset: 0 });
		expect(parseSearchArgs(["--limit", "3", "shipment"])).toEqual({
			query: "shipment",
			all: false,
			limit: 3,
			offset: 0,
		});
		expect(parseSearchArgs(["--offset", "8", "shipment"])).toEqual({
			query: "shipment",
			all: false,
			limit: 8,
			offset: 8,
		});
		expect(parseSearchArgs(["shipment", "--all"])).toEqual({ query: "shipment", all: true, limit: 8, offset: 0 });
		expect(parseSearchArgs(["--limit", "999", "x"])).toEqual({ query: "x", all: false, limit: 25, offset: 0 });
		expect(parseSearchArgs([])).toMatchObject({ error: expect.stringContaining("usage") });
	});

	it("searches the anchored project only by default", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			const reply = renderSearchReply(argv("recall index"), ctx(dir, { projectRoot: ALPHA }));
			expect(reply).toContain("aaaaaaaa-aaaa".slice(0, 7));
			expect(reply).not.toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("--all crosses projects and labels each hit by project", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			const reply = renderSearchReply(argv("--all shipment"), ctx(dir, { projectRoot: ALPHA }));
			expect(reply).toContain("[beta]");
			expect(reply).toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("unanchored (no projectRoot) searches the whole profile corpus", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			const reply = renderSearchReply(argv("shipment"), ctx(dir));
			expect(reply).toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("scrolls with --offset", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			// "the" appears in both sessions' messages -> two ranked rows across pages.
			writeSessions(dir);
			const first = renderSearchReply(argv("--limit 1 the"), ctx(dir));
			const second = renderSearchReply(argv("--limit 1 --offset 1 the"), ctx(dir));
			expect(first).toContain("match(es)");
			expect(second).toContain("match(es)");
			expect(first).not.toBe(second);
			// offset past the end reports out-of-range
			const past = renderSearchReply(argv("--limit 1 --offset 999 the"), ctx(dir));
			expect(past).toContain("no more results");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a too-short query, a no-match query, and a missing index", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			expect(renderSearchReply(argv("ab"), ctx(dir))).toContain("too short");
			expect(renderSearchReply(argv("zzzz-no-such-term"), ctx(dir))).toContain("no past sessions matched");
			expect(renderSearchReply(argv("anything"), ctx(dir, { searchIndexPath: undefined }))).toContain(
				"search unavailable",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("/sessions command", () => {
	it("browses recent sessions project-scoped by default", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			const reply = renderSessionsReply([], ctx(dir, { projectRoot: ALPHA }));
			expect(reply).toContain("[alpha]");
			expect(reply).not.toContain("bbbbbbbb-bbbb".slice(0, 7));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("--all lists sessions across projects with labels", () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-cmd-"));
		try {
			writeSessions(dir);
			const reply = renderSessionsReply(["--all"], ctx(dir));
			expect(reply).toContain("[beta]");
			expect(reply).toContain("[alpha]");
			expect(reply).toContain("recent session(s)");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects unknown args", () => {
		expect(renderSessionsReply(["nonsense"], ctx(""))).toContain("usage");
	});
});

// ---- Integration: /search through the real Gateway router ----
import { MemoryChannelIndex } from "../../src/gateway/channel-index.js";
import { fakeCompletionRunner } from "../../src/gateway/completion.js";
import { Gateway } from "../../src/gateway/gateway.js";
import type { GatewayMessage, GatewayTransport } from "../../src/gateway/types.js";

function fakeTransport() {
	const sent: Array<{ to: string; text: string }> = [];
	let handler: ((msg: GatewayMessage) => void) | undefined;
	const t: GatewayTransport = {
		async connect() {},
		async disconnect() {},
		async send(to, text) {
			sent.push({ to: to.recipient, text });
		},
		onMessage(h) {
			handler = h;
		},
	};
	return { t, sent, push: (m: GatewayMessage) => handler?.(m) };
}

describe("/search through the Gateway router", () => {
	it("runs as a local command, returns hits, and never calls the model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "axml-gw-"));
		try {
			writeSessions(dir);
			const { t, sent, push } = fakeTransport();
			const completion = fakeCompletionRunner();
			const g = new Gateway({
				transport: t,
				index: new MemoryChannelIndex(),
				completion,
				axiomHomeDir: dir,
				profile: "default",
				sessionsDir: dir,
				searchIndexPath: join(dir, "index.sqlite"),
				projectRoot: ALPHA,
				senders: ["+1"],
			});
			await g.start();
			push({ channelId: "+1", sender: "+1", text: "/search recall index", isCommand: true, timestamp: 1 });
			push({ channelId: "+1", sender: "+1", text: "/sessions --all", isCommand: true, timestamp: 2 });
			await new Promise((r) => setTimeout(r, 30));
			expect(completion.calls).toHaveLength(0);
			const searchReply = sent.find((s) => s.text.includes("match(es)"));
			expect(searchReply).toBeTruthy();
			expect(searchReply!.text).toContain("aaaaaaaa-aaaa".slice(0, 7));
			expect(searchReply!.text).not.toContain("bbbbbbbb-bbbb".slice(0, 7));
			const browseReply = sent.find((s) => s.text.includes("recent session(s)"));
			expect(browseReply).toBeTruthy();
			await g.stop();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
