import { describe, expect, it } from "vitest";
import { MIN_EVERY_INTERVAL_MS, parseDurationMs, parseInstantMs } from "../../src/core/schedule/parse.js";

describe("parseDurationMs", () => {
	it("accepts a bare number as minutes", () => {
		expect(parseDurationMs("30")).toEqual({ ok: true, ms: 1_800_000 });
	});

	it("accepts second, minute, hour, and day units", () => {
		expect(parseDurationMs("90s")).toEqual({ ok: true, ms: 90_000 });
		expect(parseDurationMs("10m")).toEqual({ ok: true, ms: 600_000 });
		expect(parseDurationMs("2h")).toEqual({ ok: true, ms: 7_200_000 });
		expect(parseDurationMs("1d")).toEqual({ ok: true, ms: 86_400_000 });
	});

	it("accepts surrounding whitespace", () => {
		expect(parseDurationMs("  10m  ")).toEqual({ ok: true, ms: 600_000 });
	});

	it("rejects zero and negative durations", () => {
		expect(parseDurationMs("0")).toEqual({ ok: false, error: expect.stringContaining("positive") });
		expect(parseDurationMs("0s").ok).toBe(false);
		expect(parseDurationMs("-5m").ok).toBe(false);
	});

	it("rejects malformed duration text", () => {
		expect(parseDurationMs("").ok).toBe(false);
		expect(parseDurationMs("ten minutes").ok).toBe(false);
		expect(parseDurationMs("5m10s").ok).toBe(false);
		expect(parseDurationMs("5.5m").ok).toBe(false);
	});

	it("enforces a minimum when one is requested", () => {
		const out = parseDurationMs("4m", { minimumMs: MIN_EVERY_INTERVAL_MS });
		expect(out.ok).toBe(false);
		if (!out.ok) expect(out.error).toContain("at least 5m");
		expect(parseDurationMs("5m", { minimumMs: MIN_EVERY_INTERVAL_MS })).toEqual({ ok: true, ms: 300_000 });
	});

	it("rejects durations that overflow a safe integer", () => {
		expect(parseDurationMs("99999999999999999d").ok).toBe(false);
	});
});

describe("parseInstantMs", () => {
	it("accepts an ISO instant with Z", () => {
		expect(parseInstantMs("2026-08-14T20:30:00Z")).toEqual({ ok: true, ms: Date.UTC(2026, 7, 14, 20, 30, 0) });
	});

	it("accepts an ISO instant with a numeric offset", () => {
		const out = parseInstantMs("2026-08-14T20:30:00+02:00");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.ms).toBe(Date.UTC(2026, 7, 14, 18, 30, 0));
	});

	it("accepts fractional seconds", () => {
		const out = parseInstantMs("2026-08-14T20:30:00.250Z");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.ms).toBe(Date.UTC(2026, 7, 14, 20, 30, 0, 250));
	});

	it("accepts a compact +hhmm offset", () => {
		const out = parseInstantMs("2026-08-14T20:30:00+0230");
		expect(out.ok).toBe(true);
		if (out.ok) expect(out.ms).toBe(Date.UTC(2026, 7, 14, 18, 0, 0));
	});

	it("rejects a zone-less local time", () => {
		expect(parseInstantMs("2026-08-14T20:30:00").ok).toBe(false);
	});

	it("rejects impossible calendar instants", () => {
		expect(parseInstantMs("2026-02-30T12:00:00Z").ok).toBe(false);
		expect(parseInstantMs("2026-13-01T12:00:00Z").ok).toBe(false);
		expect(parseInstantMs("2026-08-14T25:00:00Z").ok).toBe(false);
	});

	it("rejects non-instant text", () => {
		expect(parseInstantMs("tomorrow").ok).toBe(false);
		expect(parseInstantMs("").ok).toBe(false);
		expect(parseInstantMs("2026-08-14").ok).toBe(false);
	});
});
