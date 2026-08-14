/**
 * Schedule argument parsing (ADR-0053), pure and deterministic: durations
 * ("30", "90s", "10m", "2h", "1d" — a bare number means minutes) and absolute
 * ISO 8601 instants with an explicit zone (UTC or numeric offset). Zone-less
 * local times are rejected, as are impossible calendar instants (no Date
 * rollover surprises).
 */

/** Fixed floor for schedule_every intervals: five minutes. */
export const MIN_EVERY_INTERVAL_MS = 300_000;

const UNIT_MS: Record<string, number> = {
	s: 1000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

export type DurationParse = { ok: true; ms: number } | { ok: false; error: string };

const DURATION_RE = /^(\d+)(s|m|h|d)?$/;

/**
 * Parse a duration string into milliseconds. Accepts a bare positive integer
 * (minutes) or an integer with a unit (s/m/h/d). Rejects zero, negatives,
 * malformed text, and values that overflow a safe integer. When minimumMs is
 * given, shorter durations are rejected with an "at least" error.
 */
export function parseDurationMs(text: string, opts?: { minimumMs?: number }): DurationParse {
	const trimmed = text.trim();
	const match = DURATION_RE.exec(trimmed);
	if (!match) {
		return {
			ok: false,
			error: "delay must be a positive duration like 10m, 90s, 2h, or 1d (a bare number means minutes)",
		};
	}
	const value = Number(match[1]);
	const unit = match[2] ?? "m";
	const ms = value * (UNIT_MS[unit] ?? 0);
	if (!Number.isSafeInteger(ms)) {
		return { ok: false, error: "duration is too large" };
	}
	if (ms <= 0) {
		return { ok: false, error: "duration must be positive" };
	}
	if (opts?.minimumMs !== undefined && ms < opts.minimumMs) {
		return { ok: false, error: `interval must be at least ${Math.round(opts.minimumMs / 60_000)}m` };
	}
	return { ok: true, ms };
}

export type InstantParse = { ok: true; ms: number } | { ok: false; error: string };

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Offset "Z", "+hh:mm", "+hhmm" in milliseconds (positive = east of UTC). */
function offsetMs(sign: string, hours: string, minutes: string): number {
	const total = Number(hours) * 60 + Number(minutes);
	return sign === "-" ? -total * 60_000 : total * 60_000;
}

/**
 * Parse an absolute ISO 8601 instant into epoch milliseconds. The zone is
 * required (Z or a numeric offset) — a zone-less local time is ambiguous
 * across the gateway and the scheduling run and is rejected. Calendar sanity
 * is verified by round-tripping the components, so impossible instants like
 * 2026-02-30 fail instead of silently rolling over.
 */
export function parseInstantMs(text: string): InstantParse {
	const trimmed = text.trim();
	const match = INSTANT_RE.exec(trimmed);
	if (!match) {
		return {
			ok: false,
			error: "instant must be an ISO 8601 instant with an explicit zone (e.g. 2026-08-14T20:30:00Z or +02:00)",
		};
	}
	const [, ys, mos, ds, hs, mis, ss, frac, zone] = match;
	const y = Number(ys);
	const mo = Number(mos);
	const d = Number(ds);
	const h = Number(hs);
	const mi = Number(mis);
	const s = ss === undefined ? 0 : Number(ss);
	const f = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
		return { ok: false, error: "instant is not a valid calendar time" };
	}
	let offset: number;
	if (zone === "Z") {
		offset = 0;
	} else {
		const sign = zone.slice(0, 1);
		const digits = zone.slice(1).replace(":", "");
		offset = offsetMs(sign, digits.slice(0, 2), digits.slice(2));
	}
	const wall = Date.UTC(y, mo - 1, d, h, mi, s, f);
	const ms = wall - offset;
	// Round-trip the components: a rolled-over date (e.g. Feb 30 -> Mar 2)
	// produces different fields than the input.
	const back = new Date(wall);
	if (
		back.getUTCFullYear() !== y ||
		back.getUTCMonth() !== mo - 1 ||
		back.getUTCDate() !== d ||
		back.getUTCHours() !== h ||
		back.getUTCMinutes() !== mi ||
		back.getUTCSeconds() !== s
	) {
		return { ok: false, error: "instant is not a valid calendar time" };
	}
	if (!Number.isSafeInteger(ms)) {
		return { ok: false, error: "instant is out of range" };
	}
	return { ok: true, ms };
}
