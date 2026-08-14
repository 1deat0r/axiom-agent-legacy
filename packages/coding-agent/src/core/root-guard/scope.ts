/**
 * Root guard scope gate (ADR-0051) — pure containment classification.
 *
 * Classifies resolved candidate paths against the anchored project root.
 * Containment is LEXICAL (no realpath chase) for the freeform tools: a
 * worktree's node_modules symlink resolves outside the root and would
 * false-block the standard test workflow, and the ADR-0019 OS sandbox is the
 * strict tier anyway. The `edit` tool keeps its realpath check.
 *
 * Policy order per path: deny prefixes first (they apply even inside the
 * root, so an operator can seal a sensitive subdir), then inside-root allow,
 * then allow prefixes (config or approved grants). Everything else blocks.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface PathScopeOptions {
	/** Anchored project root (absolute). */
	root: string;
	/** Base for resolving relative candidate paths. */
	cwd: string;
	/** Home directory used for `~` expansion (default: process home). */
	home?: string;
	/** Path prefixes that may be touched even when outside the root. */
	allowPrefixes?: readonly string[];
	/** Path prefixes that are denied everywhere, including inside the root. */
	denyPrefixes?: readonly string[];
	/** Candidate path tokens (raw, unresolved). */
	paths: readonly string[];
}

export type PathScopeDecision = { block: true; reason: string; paths: string[] } | undefined;

/** True iff `target` is `root` itself or strictly inside it. */
export function isWithinPath(root: string, target: string): boolean {
	if (root === target) return true;
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Resolve a raw token to an absolute lexical path, expanding `~` / `~user`. */
export function toAbsolutePath(raw: string, cwd: string, home: string): string {
	const expanded = raw.replace(/^~[A-Za-z0-9_.+-]*/, (m) => (m === "~" ? home : `/home/${m.slice(1)}`));
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function matchesAny(prefixes: readonly string[], target: string, cwd: string, home: string): boolean {
	return prefixes.some((p) => {
		const abs = resolve(toAbsolutePath(p, cwd, home));
		return abs === target || isWithinPath(abs, target);
	});
}

/** Decision for a set of candidate paths: `undefined` to allow, else a block. */
export function checkPathScope(options: PathScopeOptions): PathScopeDecision {
	const { root, cwd } = options;
	const home = options.home ?? homedir();
	const rootAbs = resolve(root);
	const allow = options.allowPrefixes ?? [];
	const deny = options.denyPrefixes ?? [];
	const denied: string[] = [];
	const outside: string[] = [];
	for (const raw of options.paths) {
		const norm = resolve(toAbsolutePath(raw, cwd, home));
		if (matchesAny(deny, norm, cwd, home)) {
			denied.push(norm);
			continue;
		}
		if (isWithinPath(rootAbs, norm)) continue;
		if (matchesAny(allow, norm, cwd, home)) continue;
		outside.push(norm);
	}
	const paths = [...denied, ...outside];
	if (paths.length === 0) return undefined;
	const shown = paths.slice(0, 3).join(", ") + (paths.length > 3 ? ` and ${paths.length - 3} more` : "");
	const reason =
		denied.length > 0
			? `Refusing to touch ${shown} — the operator denied these paths (AXIOM_ROOT_GUARD_DENY).`
			: `Refusing to touch ${shown} — it is outside this project's root (${rootAbs}). ` +
				`The root guard blocks outside paths by default: request an escape with the ` +
				`request_root_access tool (state the paths and a plain-English reason), or ask ` +
				`the operator to add the path to AXIOM_ROOT_GUARD_ALLOW.`;
	return { block: true, reason, paths };
}
