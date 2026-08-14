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
import { join } from "node:path";
import { envList } from "../../core/env-list.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	appendAudit,
	buildStateDenies,
	defaultRootGuardStateDir,
	listGrantPrefixes,
	resolveScopeDir,
} from "../../core/root-guard/store.js";
import { axiomHome } from "../profile/registry.js";
import { decideEdit, realpathX, toAbsolute } from "./guard.js";

export { decideEdit, isWithin, realpathX, toAbsolute } from "./guard.js";

export interface WorkspaceGuardOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
	/** Base for resolving relative paths (tests). Defaults to process.cwd(). */
	cwd?: string;
	/** Extra allow prefixes (ADR-0052). Defaults to AXIOM_ROOT_GUARD_ALLOW plus active grants. */
	allowPrefixes?: readonly string[];
	/** Deny prefixes (win over allows, even inside the root). Defaults to AXIOM_ROOT_GUARD_DENY. */
	denyPrefixes?: readonly string[];
	/**
	 * Approval state root (tests). Defaults to AXIOM_ROOT_GUARD_STATE_DIR or
	 * the operator-owned /var/lib/axiom-root-guard; the state dir (and the
	 * legacy axiom-home store) is hard-denied for edits too.
	 */
	stateDir?: string;
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
		const allowPrefixes = options.allowPrefixes ?? envList(process.env.AXIOM_ROOT_GUARD_ALLOW) ?? [];
		const denyPrefixes = options.denyPrefixes ?? envList(process.env.AXIOM_ROOT_GUARD_DENY) ?? [];
		const stateDir = options.stateDir ?? process.env.AXIOM_ROOT_GUARD_STATE_DIR ?? defaultRootGuardStateDir();
		let rootReal: string | undefined;
		let scope: string | undefined;
		let stateDeniesPromise: Promise<string[]> | undefined;
		const stateDenies = (): Promise<string[]> => {
			stateDeniesPromise ??= buildStateDenies(stateDir, join(axiomHome(), "root-guard"));
			return stateDeniesPromise;
		};
		pi.on("tool_call", async (event) => {
			if (event.toolName !== "edit") return undefined;
			const raw = (event.input as { path?: unknown }).path;
			if (typeof raw !== "string" || raw.length === 0) return undefined;
			if (rootReal === undefined) rootReal = await realpathX(rawRoot);
			// Static policy first; approved grants (ADR-0052) are the recorded
			// escape. The operator-owned store is hard-denied here too.
			const denied = [...(await stateDenies()), ...denyPrefixes];
			const blocked = await decideEdit(rootReal, cwd, raw, { allowPrefixes, denyPrefixes: denied });
			if (!blocked) return undefined;
			if (scope === undefined) {
				// Fail closed with the curated block when the store is unusable:
				// a raw ENOTDIR/EACCES here would surface as a bare extension
				// error instead of the guard's plain-English reason.
				try {
					scope = await resolveScopeDir(stateDir, rawRoot);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						block: true,
						reason:
							`Root guard could not verify this edit because its store failed (${message}). ` +
							`Fix AXIOM_ROOT_GUARD_STATE_DIR (default: ${defaultRootGuardStateDir()}, operator-provisioned) and retry.`,
					};
				}
			}
			const grants = await listGrantPrefixes(scope);
			const withGrants =
				grants.length === 0
					? blocked
					: await decideEdit(rootReal, cwd, raw, {
							allowPrefixes: [...allowPrefixes, ...grants],
							denyPrefixes: denied,
						});
			if (!withGrants) {
				// A failed use-audit must not turn an authorized call into a raw
				// error: the grant itself is already recorded in grants.jsonl.
				try {
					await appendAudit(scope, { event: "grant-use", tool: "edit", paths: [toAbsolute(raw, cwd)] });
				} catch {
					/* audit degraded; the grant record is the source of truth */
				}
				return undefined;
			}
			// Edit blocks are audited like the shell gate; a failed block-audit
			// must not replace the curated reason with a raw store error.
			try {
				await appendAudit(scope, { event: "block", tool: "edit", paths: [toAbsolute(raw, cwd)] });
			} catch {
				/* audit degraded; the block reason still reaches the model */
			}
			return blocked;
		});
	};
}

export default function axiomWorkspaceExtension(pi: ExtensionAPI): void {
	createWorkspaceGuard()(pi);
}
