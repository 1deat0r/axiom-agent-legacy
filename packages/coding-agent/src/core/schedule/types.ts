/**
 * Schedule domain types (ADR-0053): model-facing reminders that return later
 * as ordinary message turns in the session they were scheduled from.
 */

/** How a reminder's due instant was chosen. */
export type ScheduleKind = "after" | "at" | "every";

/**
 * One reminder record. Stored append-only in a gateway-owned JSONL file the
 * agent (writer) and the gateway (reader) share under the axiom home.
 */
export interface ScheduleReminder {
	/** Unique id (random UUID from the scheduling run). */
	id: string;
	/** schedule_after / schedule_at / schedule_every. */
	kind: ScheduleKind;
	/** The gateway channel the reminder's turn is delivered to (the session's channel). */
	channelId: string;
	/** The session the reminder returns into as an ordinary user turn. */
	sessionId: string;
	/** The reminder text that returns as the turn's user message. */
	text: string;
	/** Due instant, epoch milliseconds (UTC). */
	dueAt: number;
	/** Fixed repetition interval in ms; present only for schedule_every. */
	intervalMs?: number;
	/** Anchored project root the reminder turn resumes under (undefined = unanchored). */
	projectRoot?: string;
	/** When the reminder was scheduled, epoch milliseconds. */
	createdAt: number;
}

/** Env tag the gateway sets on completion children so schedule tools know the channel. */
export const SCHEDULE_CHANNEL_ENV = "AXIOM_GATEWAY_CHANNEL_ID";
/** Env tag the gateway sets on completion children so schedule tools know the session. */
export const SCHEDULE_SESSION_ENV = "AXIOM_GATEWAY_SESSION_ID";

/** Shape guard: tolerate hand-edited or corrupted store lines when folding. */
export function isScheduleReminder(value: unknown): value is ScheduleReminder {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	return (
		typeof r.id === "string" &&
		r.id.length > 0 &&
		(r.kind === "after" || r.kind === "at" || r.kind === "every") &&
		typeof r.channelId === "string" &&
		r.channelId.length > 0 &&
		typeof r.sessionId === "string" &&
		r.sessionId.length > 0 &&
		typeof r.text === "string" &&
		typeof r.dueAt === "number" &&
		Number.isFinite(r.dueAt) &&
		typeof r.createdAt === "number" &&
		Number.isFinite(r.createdAt) &&
		(r.intervalMs === undefined || (typeof r.intervalMs === "number" && Number.isFinite(r.intervalMs))) &&
		(r.projectRoot === undefined || typeof r.projectRoot === "string")
	);
}
