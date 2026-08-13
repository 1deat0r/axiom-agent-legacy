/**
 * Pending-proposal staging + audit log — the operator-confirm surface of
 * automatic memory consolidation. Proposals are staged as JSON files under
 * <AXIOM_HOME>/consolidation/pending/ and resolved (approved/rejected) by the
 * `axiom memory-consolidation` CLI. Every decision is appended to
 * <AXIOM_HOME>/consolidation/audit.jsonl so auto-apply and manual approval
 * leave a reviewable trail.
 *
 * All reads tolerate malformed files (a bad line or file degrades to "absent"
 * rather than breaking listing), mirroring the harness/refinement history
 * loader's defensive style.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConsolidationAuditEvent, ConsolidationProposal, PendingProposal } from "./types.js";

export const PENDING_DIR_NAME = "pending";
export const AUDIT_FILE_NAME = "audit.jsonl";

/** Stable, time-ordered proposal id (mirrors refine_<digits>). */
export function newProposalId(now: Date = new Date()): string {
	return `mc_${now
		.toISOString()
		.replace(/[^0-9]/g, "")
		.slice(0, 17)}`;
}

export function consolidationPendingDir(consolidationDir: string): string {
	return join(consolidationDir, PENDING_DIR_NAME);
}

export function consolidationAuditPath(consolidationDir: string): string {
	return join(consolidationDir, AUDIT_FILE_NAME);
}

export function stagePendingProposal(
	pendingDir: string,
	proposal: ConsolidationProposal,
	options: { sessionId?: string; now?: Date } = {},
): PendingProposal {
	const now = options.now ?? new Date();
	const base = newProposalId(now);
	let id = base;
	let path = join(pendingDir, `${id}.json`);
	for (let suffix = 1; existsSync(path); suffix += 1) {
		id = `${base}_${suffix}`;
		path = join(pendingDir, `${id}.json`);
	}
	const pending: PendingProposal = {
		id,
		summary: proposal.summary,
		rationale: proposal.rationale,
		facts: proposal.facts,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		createdAt: now.toISOString(),
	};
	mkdirSync(pendingDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return pending;
}

function isPendingProposal(value: unknown): value is PendingProposal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === "string" &&
		typeof record.createdAt === "string" &&
		Array.isArray(record.facts) &&
		record.facts.every(
			(fact) =>
				typeof fact === "object" &&
				fact !== null &&
				typeof (fact as Record<string, unknown>).title === "string" &&
				typeof (fact as Record<string, unknown>).content === "string",
		)
	);
}

export function listPendingProposals(pendingDir: string): PendingProposal[] {
	if (!existsSync(pendingDir)) {
		return [];
	}
	const proposals: PendingProposal[] = [];
	for (const entry of readdirSync(pendingDir, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(pendingDir, entry.name), "utf8"));
			if (isPendingProposal(parsed)) {
				proposals.push(parsed);
			}
		} catch {
			// Malformed pending files are skipped, never fatal.
		}
	}
	proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return proposals;
}

const PROPOSAL_ID_PATTERN = /^mc_\d+(_\d+)?$/;

export function loadPendingProposal(pendingDir: string, id: string): PendingProposal | undefined {
	if (!PROPOSAL_ID_PATTERN.test(id)) {
		return undefined;
	}
	const path = join(pendingDir, `${id}.json`);
	if (!existsSync(path)) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return isPendingProposal(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export type ResolveAction = "approved" | "rejected";

/**
 * Load + remove a pending proposal in one step so approve/reject can audit
 * the exact staged content. Returns undefined when the proposal is unknown.
 */
export function resolvePendingProposal(
	pendingDir: string,
	id: string,
	_action: ResolveAction,
): PendingProposal | undefined {
	const pending = loadPendingProposal(pendingDir, id);
	if (!pending) {
		return undefined;
	}
	rmSync(join(pendingDir, `${pending.id}.json`), { force: true });
	return pending;
}

export function appendAuditEvent(auditPath: string, event: ConsolidationAuditEvent): string {
	mkdirSync(dirname(auditPath), { recursive: true });
	appendFileSync(auditPath, `${JSON.stringify(event)}\n`, "utf8");
	return auditPath;
}

export function readAuditEvents(auditPath: string, limit = 10): ConsolidationAuditEvent[] {
	if (!existsSync(auditPath)) {
		return [];
	}
	const events: ConsolidationAuditEvent[] = [];
	for (const line of readFileSync(auditPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				typeof parsed.id === "string" &&
				typeof parsed.action === "string"
			) {
				events.push(parsed as ConsolidationAuditEvent);
			}
		} catch {
			// Malformed audit lines are skipped, never fatal.
		}
	}
	events.reverse();
	return events.slice(0, limit);
}
