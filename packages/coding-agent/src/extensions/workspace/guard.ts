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
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Resolve a possibly-relative path against a cwd to an absolute path. */
export function toAbsolute(raw: string, cwd: string): string {
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

/** True iff `target` is the root or strictly inside it. */
export function isWithin(root: string, target: string): boolean {
	if (root === target) return true;
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

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

/** Decision for one edit path: `undefined` to allow, or a block with a reason. */
export async function decideEdit(
	rootReal: string,
	cwd: string,
	raw: string,
): Promise<{ block: true; reason: string } | undefined> {
	const abs = toAbsolute(raw, cwd);
	const target = await realpathX(abs);
	if (isWithin(rootReal, target)) return undefined;
	return {
		block: true,
		reason:
			`Refusing edit of '${raw}' — it resolves outside this project's workspace root ` +
			`(${rootReal}). Keep all file changes inside your project root.`,
	};
}
