import { describe, expect, it } from "vitest";
import { detectStyle, relativeTime, renderInbox, renderPeersList } from "../../../src/core/peers/render.js";
import type { BoardEntry, PeerSummary, PeersListResult } from "../../../src/core/peers/types.js";

const NOW = 1_800_000_000_000;

function peer(over: Partial<PeerSummary> = {}): PeerSummary {
	return {
		instanceId: "aaa11111-1234-1234-1234-123456789012",
		shortId: "aaa11111",
		runId: "run-1",
		pid: 101,
		model: "deepseek-v4-pro",
		intent: "on branch feat/x in .worktrees/x",
		startedAt: new Date(NOW - 120_000).toISOString(),
		lastSeen: new Date(NOW - 120_000).toISOString(),
		status: "active",
		...over,
	};
}

function list(over: Partial<PeersListResult> = {}): PeersListResult {
	return { self: [], active: [], stale: [], ...over };
}

function style(over: Partial<{ color: boolean; relativeTime: boolean; width: number; now: number }> = {}): {
	color: boolean;
	relativeTime: boolean;
	width: number;
	now: number;
} {
	return { color: false, relativeTime: true, width: 100, now: NOW, ...over };
}

function msg(over: Partial<BoardEntry> = {}): BoardEntry {
	return {
		ts: new Date(NOW - 300_000).toISOString(),
		from: "bbb22222-1234-1234-1234-123456789012",
		fromRun: "run-b",
		to: "*",
		kind: "group",
		text: "daily sync at 10",
		...over,
	};
}

describe("relativeTime", () => {
	it("renders just now, minutes, hours, days, and dates", () => {
		expect(relativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe("just now");
		expect(relativeTime(new Date(NOW - 120_000).toISOString(), NOW)).toBe("2m ago");
		expect(relativeTime(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toBe("2h ago");
		expect(relativeTime(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe("3d ago");
		expect(relativeTime(new Date(NOW - 40 * 86_400_000).toISOString(), NOW)).toBe("2026-12-06");
	});
	it("renders unknown for unparseable input", () => {
		expect(relativeTime("garbage", NOW)).toBe("unknown");
	});
});

describe("detectStyle", () => {
	it("FORCE_COLOR wins, NO_COLOR disables, default follows the tty", () => {
		expect(detectStyle({ FORCE_COLOR: "1" }, false).color).toBe(true);
		expect(detectStyle({ NO_COLOR: "1", FORCE_COLOR: "1" }, false).color).toBe(true);
		expect(detectStyle({ NO_COLOR: "1" }, true).color).toBe(false);
		expect(detectStyle({}, true).color).toBe(true);
		expect(detectStyle({}, false).color).toBe(false);
	});
	it("clamps the terminal width to a sane range", () => {
		expect(detectStyle({}, false, 30).width).toBe(80);
		expect(detectStyle({}, false, 100).width).toBe(100);
		expect(detectStyle({}, false, 160).width).toBe(120);
	});
});

describe("renderPeersList", () => {
	it("renders aligned rows with status glyphs, relative time, and a legend footer", () => {
		const result = list({
			active: [peer()],
			stale: [
				peer({
					shortId: "ccc33333",
					model: "",
					intent: "",
					status: "stale",
					lastSeen: new Date(NOW - 3_600_000).toISOString(),
				}),
			],
			self: [peer({ shortId: "ddd44444", status: "stale" })],
		});
		const text = renderPeersList(result, {
			selfShortId: "ddd44444",
			projectLabel: "axiom-agent",
			unread: 2,
			style: style(),
		});
		expect(text).toContain("peers in axiom-agent");
		expect(text).toContain("you: ddd44444");
		expect(text).toContain("● aaa11111");
		expect(text).toContain("○ ccc33333");
		expect(text).toContain("1h ago");
		expect(text).toContain("—");
		expect(text).toContain("(none)");
		expect(text).toContain("· you");
		expect(text).toContain("2 unread messages");
		expect(text).toContain("● active · ○ stale");
		expect(text).not.toContain("\x1b[");
	});
	it("emits ANSI colors when enabled", () => {
		const text = renderPeersList(list({ active: [peer()] }), { style: style({ color: true }) });
		expect(text).toContain("\x1b[32m");
	});
	it("renders a friendly empty state", () => {
		const text = renderPeersList(list(), { selfShortId: "aaa11111", projectLabel: "p", style: style() });
		expect(text).toContain("no other instances here right now");
	});
	it("ellipsizes long model and intent values", () => {
		const text = renderPeersList(list({ active: [peer({ model: "x".repeat(40), intent: "y".repeat(200) })] }), {
			style: style(),
		});
		expect(text).toContain("…");
		expect(text).not.toContain("y".repeat(200));
	});
});

describe("renderInbox", () => {
	it("renders badges, sender, relative time, and message text", () => {
		const text = renderInbox(
			[msg(), msg({ kind: "msg", to: "aaa11111-1234-1234-1234-123456789012", text: "hold off on commits" })],
			style(),
		);
		expect(text).toContain("peer inbox — 2 unread");
		expect(text).toContain("[group] bbb22222 · 5m ago");
		expect(text).toContain("[msg]   bbb22222");
		expect(text).toContain("daily sync at 10");
		expect(text).toContain("hold off on commits");
		expect(text).not.toContain("\x1b[");
	});
	it("renders an empty state", () => {
		expect(renderInbox([], style())).toContain("peer inbox is empty");
	});
});
