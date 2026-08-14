/**
 * Completion failure classification (gateway resilience, ADR-0051).
 *
 * A completion child can die in ways the user must never see raw: SIGTERM
 * from a competing run or a gateway restart (exit 143), SIGKILL (137), a
 * gateway-side timeout, a session held by another process, or a spawn
 * failure under resource pressure. This module maps the runner's error text
 * to a stable kind so the gateway can decide whether to retry and can tell
 * the user one short sentence instead of a command line.
 */

export type CompletionFailureKind =
	| "interrupted" // child exited after SIGTERM (143)
	| "killed" // child exited after SIGKILL (137)
	| "timeout" // gateway-side completion timeout fired
	| "session_busy" // the session lease is held by another process
	| "spawn" // the child could not start (resource pressure / missing bin)
	| "failed"; // anything else

export interface CompletionFailureInfo {
	kind: CompletionFailureKind;
	/** True when a retry has a real chance to succeed. */
	transient: boolean;
}

const CLASSIFIERS: ReadonlyArray<{ kind: CompletionFailureKind; test: RegExp }> = [
	{ kind: "interrupted", test: /completion exited with code 143\b/ },
	{ kind: "killed", test: /completion exited with code 137\b/ },
	{ kind: "timeout", test: /completion timed out after/ },
	{ kind: "session_busy", test: /Session is already active/ },
	{ kind: "spawn", test: /spawn|ENOMEM|EMFILE|EACCES|ENOENT/ },
];

/** Classify a raw runner error; every match here is considered retryable. */
export function classifyCompletionFailure(message: string): CompletionFailureInfo {
	for (const { kind, test } of CLASSIFIERS) {
		if (test.test(message)) {
			return { kind, transient: true };
		}
	}
	return { kind: "failed", transient: false };
}

const DESCRIPTIONS: Record<CompletionFailureKind, string> = {
	interrupted: "the run was interrupted before it could answer",
	killed: "the run was stopped before it could answer",
	timeout: "the run took too long and was stopped",
	session_busy: "another run was still using this conversation",
	spawn: "the agent could not start on this machine",
	failed: "the agent run failed",
};

/** Short user-facing failure text; never includes the raw command line. */
export function describeCompletionFailure(message: string): string {
	return DESCRIPTIONS[classifyCompletionFailure(message).kind];
}
