/**
 * Stream editor (streaming v2, ADR-0004/#6): turns the firehose of text deltas
 * an agent run emits into a small, strictly serialized stream of in-place
 * message edits. The naive per-delta edit floods the Bot API and lets edits
 * land out of order (an older edit can clobber newer text on screen).
 *
 * Guarantees:
 * - at most ONE edit in flight, so the platform applies them in order;
 * - edits are coalesced with a minimum spacing so the bot never floods the API;
 * - the FIRST update goes out immediately (instant first-token feedback);
 * - finish() drains everything and applies one final edit when the last shown
 *   text differs from the target, then reports whether the bubble shows the
 *   final text (false => the caller falls back to a fresh send).
 */

/** Minimum spacing between successive edits (Telegram flood safety). */
export const STREAM_EDIT_MIN_INTERVAL_MS = 120;
/** Retry budget per edit (flood-control / server errors only). */
export const STREAM_EDIT_RETRIES = 2;
/** Exponential backoff base for edit retries. */
export const STREAM_EDIT_RETRY_BASE_MS = 250;

export interface StreamEditorOptions {
	/** Applies `text` in place (e.g. Telegram editMessageText). */
	edit: (text: string) => Promise<void>;
	/** Minimum spacing between edits; defaults to STREAM_EDIT_MIN_INTERVAL_MS. */
	minIntervalMs?: number;
	/** Retry budget for transient errors; defaults to STREAM_EDIT_RETRIES. */
	retries?: number;
	/** Observability sink for swallowed edit failures; defaults to console.error. */
	logger?: (line: string) => void;
}

/**
 * Classify whether an edit failure is worth retrying. The Telegram client tags
 * HTTP failures and Bot API rejections with a `status`; retry flood-control
 * (429) and server-side (5xx) errors only. Permanent rejections (400/401/409,
 * e.g. "message is not modified") and untagged errors fail fast — the next
 * delta or the final fallback covers the gap.
 */
export function isRetryableEditError(error: unknown): boolean {
	const status = (error as { status?: number }).status;
	return status === 429 || (status !== undefined && status >= 500);
}

export class StreamEditor {
	/** The full text the bubble should currently show. */
	private target = "";
	/** The full text of the last edit that actually landed. */
	private applied = "";
	private timer: ReturnType<typeof setTimeout> | null = null;
	private editing = false;
	/** When the last edit COMPLETED (spacing is measured from completion). */
	private lastEditDoneAt = Number.NEGATIVE_INFINITY;
	private done = false;
	private waiters: Array<() => void> = [];
	private finishPromise: Promise<boolean> | undefined;
	private readonly edit: (text: string) => Promise<void>;
	private readonly minIntervalMs: number;
	private readonly retries: number;
	private readonly logger: (line: string) => void;

	constructor(options: StreamEditorOptions) {
		this.edit = options.edit;
		this.minIntervalMs = options.minIntervalMs ?? STREAM_EDIT_MIN_INTERVAL_MS;
		this.retries = options.retries ?? STREAM_EDIT_RETRIES;
		this.logger = options.logger ?? ((line) => console.error(line));
	}

	/** Replace the desired bubble text (full text, not a delta). */
	setTarget(text: string): void {
		if (this.done) return;
		if (text === this.target) return;
		this.target = text;
		this.schedule();
	}

	/**
	 * Close the stream: flush any pending text and apply one final edit when the
	 * last shown text differs. Resolves true when the bubble ends showing the
	 * final text, false when the final edit failed (caller falls back).
	 */
	finish(): Promise<boolean> {
		if (!this.finishPromise) this.finishPromise = this.finishImpl();
		return this.finishPromise;
	}

	private schedule(): void {
		if (this.timer !== null || this.editing) return;
		const since = Date.now() - this.lastEditDoneAt;
		const delay = Math.max(0, this.minIntervalMs - since);
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.pump();
		}, delay);
	}

	private async pump(): Promise<void> {
		if (this.editing) return;
		if (this.target === this.applied) {
			this.signalSettled();
			return;
		}
		this.editing = true;
		const text = this.target;
		try {
			await this.editWithRetry(text);
			this.applied = text;
		} catch (error) {
			this.logger(`stream edit failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.editing = false;
			this.lastEditDoneAt = Date.now();
		}
		if (this.target !== this.applied) {
			if (this.done) {
				// Final drain: no spacing throttle — finish() must not stall.
				void this.pump();
			} else {
				this.schedule();
			}
		}
		this.signalSettled();
	}

	private async finishImpl(): Promise<boolean> {
		this.done = true;
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		// With the timer cleared, nothing will re-trigger a pump — wait for any
		// in-flight edit to drain (its tail re-pumps), then apply the final text.
		if (this.editing) await this.settled();
		return this.applyFinal();
	}

	private async applyFinal(): Promise<boolean> {
		if (this.target === this.applied) return true;
		try {
			await this.editWithRetry(this.target);
			this.applied = this.target;
			return true;
		} catch (error) {
			this.logger(`final stream edit failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private settled(): Promise<void> {
		if (!this.editing && this.target === this.applied) return Promise.resolve();
		return new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	private signalSettled(): void {
		if (this.editing || this.target !== this.applied) return;
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) resolve();
	}

	private async editWithRetry(text: string): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.retries; attempt++) {
			try {
				await this.edit(text);
				return;
			} catch (error) {
				lastError = error;
				if (!isRetryableEditError(error) || attempt === this.retries) break;
				const backoff = STREAM_EDIT_RETRY_BASE_MS * 2 ** attempt;
				await new Promise((resolve) => setTimeout(resolve, backoff));
			}
		}
		throw lastError;
	}
}
