/**
 * Schedule extension (ADR-0053) — model-facing reminders that return later as
 * ordinary turns.
 *
 * The gateway tags every completion child with the channel and session the run
 * belongs to (AXIOM_GATEWAY_CHANNEL_ID / AXIOM_GATEWAY_SESSION_ID). When both
 * tags are present, this extension registers three tools — schedule_after
 * (positive delay), schedule_at (absolute instant), schedule_every (fixed
 * interval, five minutes minimum) — each appending one reminder record to the
 * shared JSONL store under the axiom home. The gateway's ScheduleManager later
 * folds the store, fires due reminders, and runs them as ordinary message
 * turns in the stored session, delivering the reply to the stored channel.
 *
 * Inert without the tags (interactive CLI runs, tests without overrides), so
 * reminders are only promised where a delivery path actually exists.
 */
import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	MIN_EVERY_INTERVAL_MS,
	parseDurationMs,
	parseInstantMs,
	SCHEDULE_CHANNEL_ENV,
	SCHEDULE_SESSION_ENV,
	type ScheduleReminder,
	ScheduleStore,
	scheduleStorePath,
} from "../../core/schedule/index.js";
import { axiomHome } from "../profile/registry.js";

/** Reminder text cap (same ceiling as peer messages). */
const MAX_TEXT_LENGTH = 4000;

const AfterSchema = Type.Object({
	/** Positive delay: a bare number of minutes or a unit suffix (30s, 10m, 2h, 1d). */
	delay: Type.String(),
	/** The reminder text that returns as the turn's message. */
	text: Type.String(),
});
type AfterParams = Static<typeof AfterSchema>;

const AtSchema = Type.Object({
	/** Absolute ISO 8601 instant with an explicit zone, e.g. 2026-08-14T20:30:00Z or +02:00. */
	instant: Type.String(),
	/** The reminder text that returns as the turn's message. */
	text: Type.String(),
});
type AtParams = Static<typeof AtSchema>;

const EverySchema = Type.Object({
	/** Fixed interval of at least 5m: a bare number of minutes or a unit suffix (30s, 10m, 2h, 1d). */
	interval: Type.String(),
	/** The reminder text that returns as each turn's message. */
	text: Type.String(),
});
type EveryParams = Static<typeof EverySchema>;

export interface ScheduleExtensionOptions {
	/** Gateway channel tag (tests). Defaults to AXIOM_GATEWAY_CHANNEL_ID. */
	channelId?: string;
	/** Gateway session tag (tests). Defaults to AXIOM_GATEWAY_SESSION_ID. */
	sessionId?: string;
	/** Anchored project root (tests). Defaults to AXIOM_PROJECT_ROOT. */
	projectRoot?: string;
	/** Axiom home for the store path (tests). Defaults to the active axiom home. */
	homeDir?: string;
	/** Explicit store path (tests). Defaults to <homeDir>/gateway/schedule.jsonl. */
	storePath?: string;
	/** Injectable clock and id source (tests). */
	now?: () => number;
	uuid?: () => string;
}

export function createScheduleExtension(options: ScheduleExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const channelId = options.channelId ?? process.env[SCHEDULE_CHANNEL_ENV];
		const sessionId = options.sessionId ?? process.env[SCHEDULE_SESSION_ENV];
		if (!channelId || !sessionId) return; // inert outside gateway-spawned completions

		const homeDir = options.homeDir ?? axiomHome();
		const storePath = options.storePath ?? scheduleStorePath(homeDir);
		const now = options.now ?? Date.now;
		const uuid = options.uuid ?? randomUUID;
		const store = new ScheduleStore(storePath);
		const projectRoot = options.projectRoot ?? process.env.AXIOM_PROJECT_ROOT;

		const schedule = (
			record: Omit<ScheduleReminder, "id" | "channelId" | "sessionId" | "projectRoot" | "createdAt">,
		): string => {
			const reminder: ScheduleReminder = {
				...record,
				id: uuid(),
				channelId,
				sessionId,
				createdAt: now(),
				...(projectRoot ? { projectRoot } : {}),
			};
			try {
				store.append(reminder);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return `could not store the reminder: ${message}`;
			}
			const iso = new Date(reminder.dueAt).toISOString();
			const text = reminder.text;
			if (record.intervalMs !== undefined) {
				const interval = formatInterval(record.intervalMs);
				return `scheduled repeating reminder every ${interval}: "${text}" — first turn at ${iso}, then every ${interval}.`;
			}
			return `scheduled reminder at ${iso}: "${text}" — it will arrive as an ordinary message turn in this session.`;
		};

		pi.registerTool({
			name: "schedule_after",
			label: "Schedule a reminder after a delay",
			description:
				"Schedule a one-off reminder that returns later as an ordinary message turn in this session. " +
				"Pass a positive delay (bare number = minutes, or 30s/10m/2h/1d) and the reminder text. " +
				"When the delay elapses the gateway turns the text into a user message in this session " +
				"and the agent answers it then.",
			parameters: AfterSchema,
			execute: async (_toolCallId, params: AfterParams) => {
				const delay = parseDurationMs(params.delay);
				if (!delay.ok) {
					return { content: [{ type: "text", text: `could not schedule: ${delay.error}` }], details: null };
				}
				const text = checkText(params.text);
				if (text !== undefined) {
					return { content: [{ type: "text", text: `could not schedule: ${text}` }], details: null };
				}
				return {
					content: [
						{
							type: "text",
							text: schedule({ kind: "after", text: params.text.trim(), dueAt: now() + delay.ms }),
						},
					],
					details: null,
				};
			},
		});

		pi.registerTool({
			name: "schedule_at",
			label: "Schedule a reminder at an instant",
			description:
				"Schedule a one-off reminder that returns as an ordinary message turn in this session at an " +
				"absolute instant. Pass an ISO 8601 instant with an explicit zone (Z or a numeric offset) and " +
				"the reminder text; the instant must be in the future.",
			parameters: AtSchema,
			execute: async (_toolCallId, params: AtParams) => {
				const instant = parseInstantMs(params.instant);
				if (!instant.ok) {
					return { content: [{ type: "text", text: `could not schedule: ${instant.error}` }], details: null };
				}
				if (instant.ms <= now()) {
					return {
						content: [{ type: "text", text: "could not schedule: the instant must be in the future" }],
						details: null,
					};
				}
				const text = checkText(params.text);
				if (text !== undefined) {
					return { content: [{ type: "text", text: `could not schedule: ${text}` }], details: null };
				}
				return {
					content: [{ type: "text", text: schedule({ kind: "at", text: params.text.trim(), dueAt: instant.ms }) }],
					details: null,
				};
			},
		});

		pi.registerTool({
			name: "schedule_every",
			label: "Schedule a repeating reminder",
			description:
				"Schedule a repeating reminder that returns as an ordinary message turn in this session on a fixed " +
				"interval of at least five minutes. Pass the interval (bare number = minutes, or 30s/10m/2h/1d) and " +
				"the reminder text; the first turn arrives one interval from now.",
			parameters: EverySchema,
			execute: async (_toolCallId, params: EveryParams) => {
				const interval = parseDurationMs(params.interval, { minimumMs: MIN_EVERY_INTERVAL_MS });
				if (!interval.ok) {
					return { content: [{ type: "text", text: `could not schedule: ${interval.error}` }], details: null };
				}
				const text = checkText(params.text);
				if (text !== undefined) {
					return { content: [{ type: "text", text: `could not schedule: ${text}` }], details: null };
				}
				return {
					content: [
						{
							type: "text",
							text: schedule({
								kind: "every",
								text: params.text.trim(),
								dueAt: now() + interval.ms,
								intervalMs: interval.ms,
							}),
						},
					],
					details: null,
				};
			},
		});
	};
}

/** Validate reminder text: trimmed, non-empty, within the cap. Returns an error or undefined. */
function checkText(text: string): string | undefined {
	if (text.trim().length === 0) return "reminder text must not be empty";
	if (text.length > MAX_TEXT_LENGTH) return `reminder text is too long (max ${MAX_TEXT_LENGTH} characters)`;
	return undefined;
}

/** Short human interval for confirmations ("5m", "1d", "90s"). */
function formatInterval(ms: number): string {
	for (const [unit, factor] of [
		["d", 86_400_000],
		["h", 3_600_000],
		["m", 60_000],
		["s", 1000],
	] as const) {
		if (ms % factor === 0) return `${ms / factor}${unit}`;
	}
	return `${ms}ms`;
}

/** Default built-in export (see builtInExtensions): env-tagged gateway runs only. */
export default function axiomScheduleExtension(pi: ExtensionAPI): void {
	createScheduleExtension()(pi);
}
