/**
 * Workspace root guard extension (ADR-0014, rung 3, tool seam).
 *
 * When a run is anchored to a project (AXIOM_PROJECT_ROOT set — the gateway
 * sets it and spawns the completion child with cwd = the project root), this
 * extension blocks any `edit` tool call whose resolved path escapes the
 * project root, returning a plain-English `{ block, reason }` that becomes an
 * error tool-result surfaced to the model (agent-loop.prepareToolCall).
 *
 * It is deliberately INERT when no project root is set: ordinary `axiom` runs
 * without a project are unaffected, keeping the blast radius to gateway runs.
 *
 * Honest boundary (recorded in ADR-0018): `bash`/`ipython` are freeform — no
 * string-level guard can reliably confine them — so that escape is the ADR's
 * OS-sandbox strict tier, a separate follow-up. This rung pins the structured
 * write tool and anchors cwd.
 */
import type { ExtensionAPI } from "../../core/extensions/types.js";
import { decideEdit, realpathX } from "./guard.js";

export { decideEdit, isWithin, realpathX, toAbsolute } from "./guard.js";

export interface WorkspaceGuardOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
	/** Base for resolving relative paths (tests). Defaults to process.cwd(). */
	cwd?: string;
}

/**
 * Build the workspace-root-guard extension. Returns a factory `(pi) => void`;
 * when no project root is configured the factory is a no-op (inert).
 * `rootReal` is resolved once on first use so symlinked roots normalize.
 */
export function createWorkspaceGuard(options: WorkspaceGuardOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const rawRoot = options.root ?? process.env.AXIOM_PROJECT_ROOT;
		if (!rawRoot) return; // inert unless a project root is anchored
		const cwd = options.cwd ?? process.cwd();
		let rootReal: string | undefined;
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "edit") return undefined;
			const raw = (event.input as { path?: unknown }).path;
			if (typeof raw !== "string" || raw.length === 0) return undefined;
			if (rootReal === undefined) rootReal = await realpathX(rawRoot);
			return await decideEdit(rootReal, cwd, raw);
		});
	};
}

export default function axiomWorkspaceExtension(pi: ExtensionAPI): void {
	createWorkspaceGuard()(pi);
}
