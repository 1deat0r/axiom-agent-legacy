/**
 * Axiom `delegate` tool — types for the compact result block.
 *
 * The delegate tool spawns an isolated helper process (the existing RPC
 * bridge, `--mode rpc`) to run one bounded task, then returns to the parent
 * session ONLY this compact block — the summary plus, when the helper ends
 * its run with one, the Ralph handoff (a bounded structured report). The
 * helper's intermediate tool calls and full context never enter the parent
 * session — a multi-step pipeline collapses into one zero-context-cost turn.
 */

/** Parameters accepted by the `delegate` tool. */
export interface DelegateParams {
	/** Single natural-language task instruction for one helper. */
	task?: string;
	/** Batch/parallel mode: run one fresh helper per task, concurrently. */
	tasks?: string[];
	/** Optional stable label for the helper (single mode, informational). */
	name?: string;
	/** Optional model reference for the helper (provider/model). */
	model?: string;
	/** Optional per-run budget in ms. Default 120_000; clamped to MAX_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Non-blocking mode: return immediately with a handle; collect later. */
	background?: boolean;
	/** Collect a background run (status, or the result block once settled). */
	handle?: string;
	/** Optional wait budget (ms) when collecting a running background run. */
	waitMs?: number;
}

/** Honest token accounting for the helper, from the session's recorded usage. */
export interface DelegateTokenAccounting {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/**
 * The Ralph handoff (issue #33): the bounded structured report a helper ends
 * its run with. Every field is length-capped (see handoff.ts caps), so the
 * handoff carries the helper's state back to the parent without a transcript.
 */
export interface DelegateHandoff {
	/** High-level outcome: done, partial, blocked, or failed. */
	status: string;
	/** What happened and what is finished, in short. */
	summary: string;
	/** What the helper ran, read, or observed (short strings, bounded list). */
	evidence: string[];
	/** What the parent should do next, in order. */
	nextSteps: string[];
	/** What stands in the way of completion (empty when nothing blocks). */
	blockers: string[];
}

/** Aggregated batch result for parallel `tasks` fan-out. */
export interface DelegateBatchResult {
	/** True only when every delegation finished without error/timeout. */
	ok: boolean;
	/** One compact result block per task, in input order. */
	delegations: DelegateResult[];
	/** Summed recorded token accounting across all delegations. */
	tokens: DelegateTokenAccounting;
	/** Summed recorded cost in USD across all delegations. */
	cost: number;
}

/** The compact result block returned into the parent session. */
export interface DelegateResult {
	/** Whether the helper finished (reason high-level) without error/timeout. */
	ok: boolean;
	/** Length-capped closing text/summary. NEVER a transcript of the helper. */
	summary: string;
	/** Recorded token accounting from the helper session (never guessed). */
	tokens: DelegateTokenAccounting;
	/** Recorded session cost in USD from the helper (0 when none recorded). */
	cost: number;
	/** Optional Ralph handoff (bounded structured report) the helper ended with. */
	handoff?: DelegateHandoff;
	/** Optional helper identity metadata. */
	helper?: { name?: string; model?: string; sessionId?: string };
	/** Human-readable failure reason when ok is false. */
	error?: string;
}
