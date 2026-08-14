/**
 * Schedule reminder store (ADR-0053): an append-only JSONL file under the
 * axiom home shared by the agent (which appends "schedule" records when the
 * model calls a schedule tool) and the gateway (which appends "fire" records
 * when a reminder comes due). Append-only means the two writers never race on
 * a rewrite — POSIX append is atomic for small lines — and the fold replays
 * the log into the current active set.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isScheduleReminder, type ScheduleReminder } from "./types.js";

/** A line created by a schedule tool call. */
export interface ScheduleCreateLine {
	type: "schedule";
	reminder: ScheduleReminder;
}

/** A line appended by the gateway when a reminder comes due. */
export interface ScheduleFireLine {
	type: "fire";
	id: string;
	firedAt: number;
}

export type ScheduleLine = ScheduleCreateLine | ScheduleFireLine;

/** The store file under an axiom home (gateway-owned dir, writable by both sides). */
export function scheduleStorePath(homeDir: string): string {
	return join(homeDir, "gateway", "schedule.jsonl");
}

/**
 * Fold raw store lines into the active reminder set. Later "schedule" lines
 * win for a duplicate id; a "fire" removes the id (recurring reminders are
 * re-created after their fire, so the re-create reactivates them). Unknown or
 * malformed lines are skipped, never thrown. Output is sorted by due time.
 */
export function foldSchedule(lines: readonly unknown[]): ScheduleReminder[] {
	const active = new Map<string, ScheduleReminder>();
	for (const line of lines) {
		if (typeof line !== "object" || line === null) continue;
		const record = line as { type?: unknown; id?: unknown; reminder?: unknown };
		if (record.type === "schedule" && isScheduleReminder(record.reminder)) {
			active.set(record.reminder.id, record.reminder);
		} else if (record.type === "fire" && typeof record.id === "string" && record.id.length > 0) {
			active.delete(record.id);
		}
	}
	return [...active.values()].sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
}

/** The persistent reminder store: append-only writes, folded reads. */
export class ScheduleStore {
	constructor(readonly filePath: string) {}

	/** Append a reminder record (mkdir -p the parent first). */
	append(reminder: ScheduleReminder): void {
		this.appendRecord({ type: "schedule", reminder } satisfies ScheduleCreateLine);
	}

	/** Append a fire record: marks the reminder consumed before delivery runs. */
	appendFire(id: string, firedAt: number): void {
		this.appendRecord({ type: "fire", id, firedAt } satisfies ScheduleFireLine);
	}

	/** Read the current active reminders (folds the whole log). */
	read(): ScheduleReminder[] {
		if (!existsSync(this.filePath)) return [];
		const raw = readFileSync(this.filePath, "utf8");
		const lines: unknown[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				lines.push(JSON.parse(trimmed));
			} catch {
				/* a torn or hand-edited line is skipped; the rest still folds */
			}
		}
		return foldSchedule(lines);
	}

	private appendRecord(record: ScheduleLine): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
	}
}
