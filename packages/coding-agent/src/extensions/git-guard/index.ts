/**
 * Git guard extension (ADR-0048) - tool seam wiring.
 *
 * Ships the git-guard matcher on the `tool_call` seam for the freeform shell
 * tools (`bash`, `ipython`), gated exactly like the security fence: INERT
 * unless a run is anchored by AXIOM_PROJECT_ROOT (or an explicit deps.root).
 * When anchored, a shell tool call whose text matches a destructive-git pattern
 * is blocked with a reason surfaced to the model.
 *
 * Best-effort by design (ADR-0018/ADR-0019 honest boundary): string matching
 * stops accidental destructive forms; it is not OS confinement. The operator's
 * own `user_bash` (!) commands are never guarded.
 *
 * Configuration:
 *  - AXIOM_GIT_GUARD_ALLOW  comma-separated exact command strings (escape)
 */
import type { ExtensionAPI } from "../../core/extensions/types.js";
import { checkGitCommand, type GitGuardOptions } from "./guard.js";

/** Parse a comma-separated env list, trimming empties; undefined when unset. */
function envList(value: string | undefined): string[] | undefined {
	if (!value || value.length === 0) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export interface GitGuardExtensionOptions extends GitGuardOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
}

/** Shell text from a tool-call input, or undefined for non-shell tools. */
function shellText(toolName: string, input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	if (toolName === "bash") {
		const command = record.command;
		return typeof command === "string" ? command : undefined;
	}
	if (toolName === "ipython") {
		const code = record.code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

/**
 * Build the git-guard extension. Returns a factory `(pi) => void`; when no
 * project root is configured the factory is a no-op (inert), keeping the blast
 * radius to anchored gateway/project runs.
 */
export function createGitGuard(options: GitGuardExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const rawRoot = options.root ?? process.env.AXIOM_PROJECT_ROOT;
		if (!rawRoot) return; // inert unless a project root is anchored
		const allowExact = options.allowExact ?? envList(process.env.AXIOM_GIT_GUARD_ALLOW) ?? [];
		const extraPatterns = options.extraPatterns;
		pi.on("tool_call", async (event) => {
			const text = shellText(event.toolName, event.input);
			if (text === undefined) return undefined;
			const decision = checkGitCommand(text, { allowExact, extraPatterns });
			if (!decision) return undefined;
			return { block: true, reason: decision.reason };
		});
	};
}

export default function axiomGitGuardExtension(pi: ExtensionAPI): void {
	createGitGuard()(pi);
}

export { checkGitCommand, DEFAULT_GIT_GUARD_PATTERNS } from "./guard.js";
