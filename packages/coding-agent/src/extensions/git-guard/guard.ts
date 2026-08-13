/**
 * Git guard (ADR-0048) - pure matcher.
 *
 * Detects destructive git invocations in shell text (the bash tool's command
 * or an ipython cell) and returns a block decision naming the pattern. This is
 * a BEST-EFFORT, conservative string gate - the ADR-0018 honest boundary still
 * holds: it is not confinement (that is the ADR-0019 OS sandbox) and a
 * determined caller can reword around it. It stops the common accidental
 * destructive forms before they run.
 */

export interface GitGuardPattern {
	/** Stable identifier surfaced in the block reason. */
	id: string;
	/** Regex tested against the whole command text. */
	pattern: RegExp;
}

/**
 * Default dangerous-git patterns, a port of the git-guardrails skill blocklist
 * (push in all forms, reset --hard, clean -f variants, branch -D, checkout and
 * restore of the working tree via ".").
 */
export const DEFAULT_GIT_GUARD_PATTERNS: readonly GitGuardPattern[] = [
	{ id: "push", pattern: /\bgit\s+push\b/ },
	{ id: "reset-hard", pattern: /\bgit\s+reset\s+--hard\b/ },
	{ id: "clean-force", pattern: /\bgit\s+clean(?:\s+-[a-z]*f[a-z]*|\s+--force)\b/ },
	{ id: "branch-delete-force", pattern: /\bgit\s+branch\s+[^\n;|&]*-D\b/ },
	{ id: "checkout-dot", pattern: /\bgit\s+checkout(?:\s+--)?\s+\.(?:\s|$)/ },
	{ id: "restore-dot", pattern: /\bgit\s+restore(?:\s+--)?\s+\.(?:\s|$)/ },
];

export interface GitGuardOptions {
	/** Extra patterns appended to the defaults (per-project tuning). */
	extraPatterns?: readonly GitGuardPattern[];
	/** Exact command strings (trimmed) that bypass the guard. */
	allowExact?: readonly string[];
}

export type GitGuardDecision = { blocked: true; pattern: string; reason: string } | undefined;

/** Decision for one shell text: `undefined` to allow, or a block naming the pattern. */
export function checkGitCommand(text: string, options: GitGuardOptions = {}): GitGuardDecision {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	if ((options.allowExact ?? []).some((allowed) => allowed.trim() === trimmed)) return undefined;

	const patterns = [...DEFAULT_GIT_GUARD_PATTERNS, ...(options.extraPatterns ?? [])];
	for (const { id, pattern } of patterns) {
		if (pattern.test(text)) {
			return {
				blocked: true,
				pattern: id,
				reason:
					`Git guard blocked this command: it matches the destructive-git pattern '${id}'. ` +
					`Destructive git operations need operator approval. If this exact command is ` +
					`authorized, ask the operator to add it to AXIOM_GIT_GUARD_ALLOW, or run it ` +
					`from the operator's own terminal.`,
			};
		}
	}
	return undefined;
}
