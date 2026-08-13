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
	/**
	 * Max characters one bubble may show. When a target would exceed it, the
	 * current bubble commits at the cap and `rollover` is called with the
	 * overflow text so the caller can open a fresh message (long replies
	 * stream across several bubbles instead of one oversized edit).
	 */
	maxTextLength?: number;
	/**
	 * Called (in order) when the current bubble hits maxTextLength. `overflow`
	 * is the text that continues on the NEW bubble; the caller sends a fresh
	 * placeholder and the editor resumes targeting it on the next setTarget.
	 */
	rollover?: (overflow: string) => Promise<void>;
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
	/** The full text the bubble(s) should currently show. */
	private target = "";
	/** The text shown in the CURRENT bubble (the last edit that landed). */
	private applied = "";
	/**
	 * Char offset into `target` where the current bubble begins. Bubbles are
	 * sequential windows of the full reply: bubble N shows
	 * target[bubbleStart..bubbleStart+maxTextLength); when a target would
	 * exceed the cap, the current bubble commits at the cap, `bubbleStart`
	 * advances, and `rollover(overflow)` opens a fresh bubble.
	 */
	private bubbleStart = 0;
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
	private readonly maxTextLength: number | undefined;
	private readonly rollover: ((overflow: string) => Promise<void>) | undefined;

	constructor(options: StreamEditorOptions) {
		this.edit = options.edit;
		this.minIntervalMs = options.minIntervalMs ?? STREAM_EDIT_MIN_INTERVAL_MS;
		this.retries = options.retries ?? STREAM_EDIT_RETRIES;
		this.logger = options.logger ?? ((line) => console.error(line));
		this.maxTextLength = options.maxTextLength;
		this.rollover = options.rollover;
	}

	/** Replace the desired bubble text (full text, not a delta). */
	setTarget(text: string): void {
		if (this.done) return;
		if (text === this.target) return;
		this.target = text;
		this.schedule();
	}

	/**
	 * The text that still needs to land on the CURRENT bubble. After a
	 * rollover this is the unlanded tail; the batch fallback sends exactly
	 * this (the committed bubbles are already on screen).
	 */
	remainingText(): string {
		return this.target.slice(this.bubbleStart);
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

	/** The text the CURRENT bubble should show (the tail of the full target). */
	private currentBubbleText(): string {
		return this.target.slice(this.bubbleStart);
	}

	/**
	 * While the current bubble's text exceeds the cap, commit the bubble at the
	 * cap (best-effort edit), advance the window, and open the next bubble via
	 * `rollover(overflow)`. Returns true when at least one rollover ran.
	 * Commit-edit failures are logged, never fatal: the bubble is stale, but the
	 * stream must keep moving so the final tail still lands.
	 */
	private async rollOverPending(): Promise<boolean> {
		if (this.maxTextLength === undefined || this.rollover === undefined) return false;
		let rolled = false;
		while (this.currentBubbleText().length > this.maxTextLength) {
			rolled = true;
			const commit = this.target.slice(this.bubbleStart, this.bubbleStart + this.maxTextLength);
			try {
				await this.editWithRetry(commit);
				this.applied = commit;
			} catch (error) {
				this.logger(`stream bubble commit failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.bubbleStart += this.maxTextLength;
			// The overflow handed to the caller is the NEXT cap-sized chunk (the
			// text the new bubble should eventually show), not the whole tail.
			const overflow = this.target.slice(this.bubbleStart, this.bubbleStart + this.maxTextLength);
			await this.rollover(overflow);
			// The new bubble has not been edited yet; nothing counts as applied.
			this.applied = "";
		}
		return rolled;
	}

	private async pump(): Promise<void> {
		if (this.editing) return;
		if (this.currentBubbleText() === this.applied) {
			this.signalSettled();
			return;
		}
		this.editing = true;
		let rolled = false;
		try {
			rolled = await this.rollOverPending();
			// After a rollover the new bubble is owned by the next setTarget:
			// the placeholder is left untouched until more text arrives.
			if (!rolled) {
				const text = this.currentBubbleText();
				await this.editWithRetry(text);
				this.applied = text;
			}
		} catch (error) {
			this.logger(`stream edit failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.editing = false;
			this.lastEditDoneAt = Date.now();
		}
		// A rollover hands the new bubble to the next setTarget (or to finish's
		// final edit); only a plain text edit re-schedules the pump.
		if (!rolled && this.currentBubbleText() !== this.applied) {
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
		// A pending overflow must roll before the final edit lands (finish is
		// the last chance to split an oversized tail into a fresh bubble).
		await this.rollOverPending();
		const text = this.currentBubbleText();
		if (text === this.applied) return true;
		try {
			await this.editWithRetry(text);
			this.applied = text;
			return true;
		} catch (error) {
			this.logger(`final stream edit failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private settled(): Promise<void> {
		if (!this.editing && this.currentBubbleText() === this.applied) return Promise.resolve();
		return new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	private signalSettled(): void {
		if (this.editing || this.currentBubbleText() !== this.applied) return;
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
