/**
 * `axiom memory-consolidation` — the operator-confirm surface for automatic
 * memory consolidation. The extension stages proposals; this command reviews
 * and resolves them:
 *
 *   pending              list staged proposals
 *   show <id>            print one proposal's facts
 *   approve <id>         apply to the global harness (dedup re-checked) + audit
 *   reject <id>          discard + audit
 *   audit [--limit <n>]  tail the audit log
 *
 * Returns true when the invocation was a memory-consolidation command.
 */

import { join } from "node:path";
import {
	appendAuditEvent,
	applyMemoryFacts,
	type ConsolidationAuditEvent,
	consolidationAuditPath,
	consolidationPendingDir,
	listPendingProposals,
	loadPendingProposal,
	readAuditEvents,
	resolvePendingProposal,
} from "../core/memory-consolidation/index.js";
import { CONSOLIDATION_DIR_NAME } from "../core/ownership-lattice/index.js";
import { getGlobalHarnessStateDir } from "../core/refinement/index.js";
import { axiomHome } from "../extensions/profile/registry.js";

export const MEMORY_CONSOLIDATION_USAGE =
	"axiom memory-consolidation pending|show <id>|approve <id>|reject <id>|audit [--limit <n>]";

export type MemoryConsolidationCommand = "pending" | "show" | "approve" | "reject" | "audit";

export interface MemoryConsolidationCommandOptions {
	command: MemoryConsolidationCommand;
	id?: string;
	limit?: number;
	json?: boolean;
}

export type MemoryConsolidationParseResult =
	| { ok: true; options: MemoryConsolidationCommandOptions }
	| { ok: false; help?: boolean; errors: string[] };

const COMMANDS = ["pending", "show", "approve", "reject", "audit"] as const;

export function parseMemoryConsolidationArgs(args: readonly string[]): MemoryConsolidationParseResult {
	if (args.includes("--help") || args.includes("-h")) {
		return { ok: false, help: true, errors: [] };
	}
	const command = args[0];
	if (!command || !(COMMANDS as readonly string[]).includes(command)) {
		return {
			ok: false,
			errors: [`expected one of ${COMMANDS.join("|")} (got ${command ? `"${command}"` : "nothing"})`],
		};
	}
	const options: MemoryConsolidationCommandOptions = { command: command as MemoryConsolidationCommand };

	if (command === "pending") {
		return { ok: true, options };
	}
	if (command === "audit") {
		const limitIndex = args.indexOf("--limit");
		if (limitIndex >= 0) {
			const raw = args[limitIndex + 1];
			const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
			if (!raw || !Number.isFinite(parsed) || parsed < 1) {
				return { ok: false, errors: ["--limit requires a positive integer"] };
			}
			options.limit = parsed;
		}
		options.json = args.includes("--json");
		return { ok: true, options };
	}
	// show/approve/reject require an id
	const id = args[1];
	if (!id || id.startsWith("--")) {
		return { ok: false, errors: [`memory-consolidation ${command} requires a proposal id`] };
	}
	options.id = id;
	return { ok: true, options };
}

export interface MemoryConsolidationCommandDeps {
	/** Consolidation root (default <AXIOM_HOME>/consolidation). */
	consolidationDir?: string;
	/** Global harness state dir (default getGlobalHarnessStateDir()). */
	harnessStateDir?: string;
	/** Output sink (default console.log). */
	write?: (line: string) => void;
}

export async function handleMemoryConsolidationCommand(
	args: readonly string[],
	deps: MemoryConsolidationCommandDeps = {},
): Promise<boolean> {
	if (args[0] !== "memory-consolidation") {
		return false;
	}
	const rest = args.slice(1);
	const parsed = parseMemoryConsolidationArgs(rest);
	const write = deps.write ?? ((line: string) => console.log(line));
	if (!parsed.ok) {
		if (parsed.help) {
			write(`Usage: ${MEMORY_CONSOLIDATION_USAGE}`);
			write("");
			write("Review and resolve memory-consolidation proposals staged at the end of agent runs:");
			write("  pending              list staged proposals");
			write("  show <id>            print one proposal's facts");
			write("  approve <id>         apply the proposal's facts to the global harness memory");
			write("  reject <id>          discard the proposal");
			write("  audit [--limit <n>]  show the newest audit events (default 10)");
			return true;
		}
		for (const error of parsed.errors) {
			write(`memory-consolidation: ${error}`);
		}
		write(`Usage: ${MEMORY_CONSOLIDATION_USAGE}`);
		return true;
	}

	const consolidationDir = deps.consolidationDir ?? join(axiomHome(), CONSOLIDATION_DIR_NAME);
	const harnessStateDir = deps.harnessStateDir ?? getGlobalHarnessStateDir();
	const pendingDir = consolidationPendingDir(consolidationDir);
	const auditPath = consolidationAuditPath(consolidationDir);
	const { command } = parsed.options;

	if (command === "pending") {
		const proposals = listPendingProposals(pendingDir);
		if (proposals.length === 0) {
			write("No pending memory-consolidation proposals.");
			return true;
		}
		write(`Pending memory-consolidation proposals (${proposals.length}):`);
		for (const proposal of proposals) {
			const when = proposal.createdAt.slice(0, 16).replace("T", " ");
			const session = proposal.sessionId ? ` session=${proposal.sessionId}` : "";
			write(`  ${proposal.id}  ${when}${session}  ${proposal.facts.length} fact(s) — ${proposal.summary}`);
		}
		write("Use 'axiom memory-consolidation show <id>' for details, then approve or reject.");
		return true;
	}

	if (command === "audit") {
		const events = readAuditEvents(auditPath, parsed.options.limit ?? 10);
		if (events.length === 0) {
			write("No memory-consolidation audit events yet.");
			return true;
		}
		if (parsed.options.json) {
			for (const event of [...events].reverse()) {
				write(JSON.stringify(event));
			}
			return true;
		}
		write(`Memory-consolidation audit (newest first, ${events.length}):`);
		for (const event of events) {
			const when = event.createdAt.slice(0, 16).replace("T", " ");
			const proposal = event.proposalId ? ` ${event.proposalId}` : "";
			const entryIds = event.entryIds?.length ? ` entries=${event.entryIds.join(",")}` : "";
			const error = event.error ? ` error=${event.error}` : "";
			write(
				`  ${event.id} ${when} ${event.action}${proposal} accepted=${event.accepted}/${event.proposed}${entryIds}${error}`,
			);
			for (const reason of event.rejected) {
				write(`    rejected: ${reason}`);
			}
		}
		return true;
	}

	const id = parsed.options.id ?? "";
	const pending = loadPendingProposal(pendingDir, id);
	if (!pending) {
		write(`memory-consolidation: unknown proposal "${id}"`);
		return true;
	}

	if (command === "show") {
		write(
			`Proposal ${pending.id} (${pending.createdAt.slice(0, 16).replace("T", " ")})${pending.sessionId ? ` session=${pending.sessionId}` : ""}`,
		);
		write(`Summary: ${pending.summary}`);
		write(`Rationale: ${pending.rationale}`);
		write(`Facts (${pending.facts.length}):`);
		pending.facts.forEach((fact, index) => {
			write(`  ${index + 1}. [${fact.path ?? "general"}] ${fact.title}`);
			write(`     ${fact.content}`);
		});
		return true;
	}

	const auditEvent = (
		action: "approved" | "rejected",
		extra: Partial<ConsolidationAuditEvent>,
	): ConsolidationAuditEvent => ({
		id: `mc_audit_${Date.now()}`,
		action,
		proposalId: pending.id,
		...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
		proposed: pending.facts.length,
		accepted: 0,
		rejected: [],
		createdAt: new Date().toISOString(),
		...extra,
	});

	if (command === "approve") {
		const applied = applyMemoryFacts({
			facts: pending.facts,
			harnessStateDir,
			proposalId: pending.id,
			...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
			summary: pending.summary,
			rationale: pending.rationale,
		});
		const entryIds = applied.result?.appliedEdits.filter((edit) => edit.applied).map((edit) => edit.id) ?? [];
		const rejected = applied.skipped.map((skip) => `${skip.fact.title || "(untitled)"}: ${skip.reasons.join("; ")}`);
		const resolved = resolvePendingProposal(pendingDir, pending.id);
		appendAuditEvent(
			auditPath,
			auditEvent("approved", {
				accepted: applied.acceptedCount,
				...(entryIds.length > 0 ? { entryIds } : {}),
				...(rejected.length > 0 ? { rejected } : {}),
			}),
		);
		if (!resolved) {
			// The apply already happened; report the facts, not just the lost file.
			write(
				applied.acceptedCount > 0
					? `Approved ${pending.id}: ${applied.acceptedCount} harness memory entr${applied.acceptedCount === 1 ? "y" : "ies"} applied, but the pending file was already removed`
					: `Approved ${pending.id}: pending file was already removed`,
			);
			return true;
		}
		if (applied.acceptedCount > 0) {
			write(
				`Approved ${pending.id}: ${applied.acceptedCount} harness memory entr${applied.acceptedCount === 1 ? "y" : "ies"} applied (${entryIds.join(", ")})`,
			);
		} else {
			write(`Approved ${pending.id}: nothing new to apply (all facts were duplicates or failed the gate)`);
		}
		for (const reason of rejected) {
			write(`  skipped: ${reason}`);
		}
		return true;
	}

	// reject
	const resolved = resolvePendingProposal(pendingDir, pending.id);
	appendAuditEvent(auditPath, auditEvent("rejected", {}));
	if (!resolved) {
		write("memory-consolidation: proposal disappeared before it could be resolved");
		return true;
	}
	write(`Rejected ${pending.id}: ${pending.facts.length} fact(s) discarded (audited)`);
	return true;
}
