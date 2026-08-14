/**
 * Workspace root guard — pure path-containment logic (ADR-0014, rung 3).
 *
 * The drift boundary for an anchored project run: an `edit` whose RESOLVED
 * path leaves the project root is blocked. Guard logic is pure and
 * dependency-injected so it is trivially unit-testable; the extension wiring
 * lives in index.ts.
 *
 * Resolution correctness matters more than speed here:
 *  - Both the root and the target are realpath-normalized, so a symlinked
 *    root or a symlink whose target escapes is caught, not merely `startsWith`.
 *  - A not-yet-created target (a new file) is resolved to its nearest
 *    existing ancestor, then rebased, so writes to new files inside the root
 *    are allowed while new files outside it are still blocked.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isWithinPath } from "../../core/root-guard/scope.js";

/** Resolve a possibly-relative path against a cwd to an absolute path. */
export function toAbsolute(raw: string, cwd: string): string {
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/**
 * One containment predicate for the whole rung-3 guard (ADR-0052): the core
 * scope module owns it; this alias keeps the ADR-0018 export stable.
 */
export const isWithin = isWithinPath;

/**
 * realpath, walking up to the nearest existing ancestor when the target does
 * not exist yet (new-file case) and rebasing the tail below it. Falls back to
 * the lexically-normalized path if nothing up to `/` resolves (defensive).
 */
export async function realpathX(path: string): Promise<string> {
	let cur = resolve(path);
	const tail: string[] = [];
	for (;;) {
		try {
			const realCur = await realpath(cur);
			return tail.length === 0 ? realCur : resolve(realCur, ...tail);
		} catch {
			/* path (or an ancestor) does not exist yet — keep walking up */
		}
		const parent = dirname(cur);
		if (parent === cur) return resolve(path);
		tail.unshift(basename(cur));
		cur = parent;
	}
}

export interface DecideEditOptions {
	/** Path prefixes that unblock an otherwise-outside edit (ADR-0052 approvals). */
	allowPrefixes?: readonly string[];
	/** Path prefixes denied everywhere, even inside the root (wins over allows). */
	denyPrefixes?: readonly string[];
}

/** Expand `~` / `~/` / `~user` like the shell gate's scope.ts (~user -> /home/<user>). */
function expandTilde(raw: string, home = homedir()): string {
	const m = raw.match(/^~[A-Za-z0-9_.+-]*/);
	if (!m) return raw;
	const token = m[0];
	if (token === "~") return raw === "~" ? home : join(home, raw.slice(1));
	if (token === "~-") return raw; // OLDPWD — lexical best-effort, resolved against cwd
	return `/home/${token.slice(1)}${raw.slice(token.length)}`;
}

/**
 * Decision for one edit path: `undefined` to allow, or a block with a reason.
 * An escape is allowed when the lexical path or its resolved target sits
 * under an allow prefix (operator config or an approved grant).
 */
export async function decideEdit(
	rootReal: string,
	cwd: string,
	raw: string,
	options: DecideEditOptions = {},
): Promise<{ block: true; reason: string } | undefined> {
	const abs = toAbsolute(raw, cwd);
	const target = await realpathX(abs);
	// Prefixes resolve against the anchored cwd (not process.cwd(), which the
	// ipython kernel can drift from): a deny like ".secrets" must mean
	// "<project root>/.secrets" wherever the process happens to sit.
	const normPrefix = (prefix: string): string => {
		// `~+` is bash PWD; it may carry a suffix (`~+/sub`) — expand both forms.
		const expanded = prefix.startsWith("~+") ? cwd + prefix.slice(2) : expandTilde(prefix);
		return resolve(toAbsolute(expanded, cwd));
	};
	for (const prefix of options.denyPrefixes ?? []) {
		const norm = normPrefix(prefix);
		if (isWithin(norm, abs) || isWithin(norm, target)) {
			return {
				block: true,
				reason:
					`Refusing edit of '${raw}' — the operator denied this path ` +
					`(AXIOM_ROOT_GUARD_DENY; no approval can override a deny).`,
			};
		}
	}
	if (isWithin(rootReal, target)) return undefined;
	for (const prefix of options.allowPrefixes ?? []) {
		const norm = normPrefix(prefix);
		if (isWithin(norm, abs) || isWithin(norm, target)) return undefined;
	}
	return {
		block: true,
		reason:
			`Refusing edit of '${raw}' — it resolves outside this project's workspace root ` +
			`(${rootReal}). Keep all file changes inside your project root, or request an escape ` +
			`with the request_root_access tool (plain-English reason; the operator approves or rejects).`,
	};
}
