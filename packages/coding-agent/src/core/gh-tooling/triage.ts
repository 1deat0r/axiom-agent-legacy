export const TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;

export type TriageRole = (typeof TRIAGE_ROLES)[number];

export const WAYFINDER_LABELS = [
	"wayfinder:map",
	"wayfinder:research",
	"wayfinder:prototype",
	"wayfinder:grilling",
	"wayfinder:task",
] as const;

export type WayfinderLabel = (typeof WAYFINDER_LABELS)[number];

export const ALL_LABELS: string[] = [...TRIAGE_ROLES, ...WAYFINDER_LABELS];

export type TriageAction = "skip" | "needs-triage" | "role-conflict" | "remind";

export interface TriageDecision {
	action: TriageAction;
	label?: string;
	comment?: string;
}

export function buildTriageComment(): string {
	return [
		"This issue has no role label. The workflow applied `needs-triage`.",
		"",
		"Set the role from the five in docs/agents/triage-labels.md. To mark the issue ready for an agent, the body needs five parts:",
		"",
		"1. Goal. One sentence. States the outcome.",
		"2. Acceptance criteria. A checklist. Each item must be verifiable.",
		"3. Scope. Lists what the issue does not cover.",
		'4. ADR status. States "ADR required" or "ADR not required". One capability, one ADR.',
		"5. Verification plan. States how to prove the work. Red tests first. ./test.sh, biome, and tsgo clean.",
		"",
		"When all five parts are present, change the label to `ready-for-agent`.",
	].join("\n");
}

export function findRoleLabels(labels: readonly string[]): string[] {
	return labels.filter((label) => (TRIAGE_ROLES as readonly string[]).includes(label));
}

export function buildRoleConflictComment(roles: readonly string[]): string {
	const list = roles.map((role) => `- \`${role}\``).join("\n");
	return [
		"Two or more role labels are present on this issue.",
		"",
		list,
		"",
		"The vocabulary allows exactly one role label per issue. Keep one and remove the rest with:",
		"",
		"gh issue edit <number> --remove-label <label>",
	].join("\n");
}

export type OpenEvent = "opened" | "labeled" | "unlabeled";

export function classifyOpen(labels: readonly string[], event: OpenEvent): TriageDecision {
	const roles = findRoleLabels(labels);
	if (event === "unlabeled") {
		if (roles.length === 0) {
			return { action: "remind", comment: buildTriageComment() };
		}
		return { action: "skip" };
	}
	if (roles.length > 1) {
		return { action: "role-conflict", comment: buildRoleConflictComment(roles) };
	}
	if (roles.length === 1) {
		return { action: "skip" };
	}
	return {
		action: "needs-triage",
		label: "needs-triage",
		comment: buildTriageComment(),
	};
}

export function decide(json: string, event: string): TriageDecision {
	let parsed: { labels?: Array<string | { name?: string }> };
	try {
		parsed = JSON.parse(json) as { labels?: Array<string | { name?: string }> };
	} catch {
		throw new Error("triage-cli: stdin is not valid JSON");
	}
	const labels = (parsed.labels ?? [])
		.map((label) => (typeof label === "string" ? label : (label.name ?? "")))
		.filter((name) => name.length > 0);
	const openEvent: OpenEvent = event === "labeled" || event === "unlabeled" ? event : "opened";
	return classifyOpen(labels, openEvent);
}

export const AUDIT_MARKERS = ["Commit:", "ADR:", "Handoff:"] as const;

const NUDGE_MARKER = "This issue closed without the audit comment.";

export interface CloseDecision {
	action: "skip" | "nudge";
	comment?: string;
}

export function buildCloseNudge(): string {
	return [
		NUDGE_MARKER,
		"",
		"The close ritual (docs/agents/issue-tracker.md) asks for one comment that links three artifacts:",
		"",
		"- the merge commit (or the final commit hash)",
		"- the ADR file (when the work required one)",
		"- the handoff doc",
		"",
		"Post the audit comment to complete the trail.",
	].join("\n");
}

export function classifyClose(comments: readonly { body?: string }[]): CloseDecision {
	const bodies = comments.map((comment) => comment.body ?? "");
	if (bodies.some((body) => body.includes(NUDGE_MARKER))) {
		return { action: "skip" };
	}
	const hasAudit = bodies.some((body) => AUDIT_MARKERS.every((marker) => body.includes(marker)));
	if (hasAudit) {
		return { action: "skip" };
	}
	return { action: "nudge", comment: buildCloseNudge() };
}

export function decideClose(json: string): CloseDecision {
	let parsed: { comments?: Array<{ body?: string }> };
	try {
		parsed = JSON.parse(json) as { comments?: Array<{ body?: string }> };
	} catch {
		throw new Error("triage-close-cli: stdin is not valid JSON");
	}
	return classifyClose(parsed.comments ?? []);
}
