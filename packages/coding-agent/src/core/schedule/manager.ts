/**
 * Schedule manager (ADR-0053): the gateway-side loop that turns due reminders
 * into ordinary turns. On start it sweeps immediately (so a reminder that
 * missed its time while the gateway was down fires exactly once on the next
 * boot), then re-sweeps on a fixed poll. A sweep appends each reminder's fire
 * record BEFORE handing it to onDue, so a crash mid-delivery never re-fires;
 * recurring reminders are re-created at their earliest future slot in the same
 * sweep, so a long downtime collapses missed occurrences into a single turn.
 */
import { ScheduleStore } from "./store.js";
import type { ScheduleReminder } from "./types.js";

/** Default sweep cadence while the gateway is up. */
export const DEFAULT_SCHEDULE_POLL_MS = 10_000;

export interface ScheduleManagerOptions {
	/** Path of the shared JSONL store (scheduleStorePath(axiomHome)). */
	storePath: string;
	/** Injectable clock (tests). Defaults to the wall clock. */
	now?: () => Date;
	/** Poll cadence in ms (default 10s). */
	pollMs?: number;
	/** Deliver one due reminder (fire-and-forget; errors are caught here). */
	onDue: (reminder: ScheduleReminder) => void;
}

/** The gateway-side schedule loop: fold, sweep, poll. */
export class ScheduleManager {
	private readonly store: ScheduleStore;
	private readonly now: () => Date;
	private readonly pollMs: number;
	private readonly onDue: (reminder: ScheduleReminder) => void;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private started = false;
	private running = false;

	constructor(options: ScheduleManagerOptions) {
		this.store = new ScheduleStore(options.storePath);
		this.now = options.now ?? (() => new Date());
		this.pollMs = Math.max(0, options.pollMs ?? DEFAULT_SCHEDULE_POLL_MS);
		this.onDue = options.onDue;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.sweep();
		this.scheduleNext();
	}

	stop(): void {
		this.started = false;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Nudge the loop (after a schedule tool appended a record; also tests). */
	wake(): void {
		if (!this.started) return;
		this.scheduleNext(0);
	}

	/**
	 * Fire every reminder due at `now` (default: the clock) and return how many
	 * fired. The fire record is appended before onDue runs, and recurring
	 * reminders are re-created at their earliest future slot, all in one
	 * synchronous pass — a later sweep can never double-fire the same slot.
	 */
	sweep(now: Date = this.now()): number {
		if (this.running) return 0;
		this.running = true;
		try {
			const nowMs = now.getTime();
			const due = this.store.read().filter((reminder) => reminder.dueAt <= nowMs);
			for (const reminder of due) {
				this.store.appendFire(reminder.id, nowMs);
				if (reminder.intervalMs !== undefined && reminder.intervalMs > 0) {
					let nextDue = reminder.dueAt + reminder.intervalMs;
					while (nextDue <= nowMs) nextDue += reminder.intervalMs;
					this.store.append({ ...reminder, dueAt: nextDue, createdAt: nowMs });
				}
				try {
					this.onDue(reminder);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`schedule: delivery of reminder ${reminder.id} failed: ${message}`);
				}
			}
			return due.length;
		} finally {
			this.running = false;
		}
	}

	private scheduleNext(delayMs?: number): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (!this.started) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (!this.started) return;
			this.sweep();
			this.scheduleNext();
		}, delayMs ?? this.pollMs);
	}
}
