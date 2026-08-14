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

export interface TriageDecision {
	action: "skip" | "needs-triage";
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

export function classifyIssue(labels: readonly string[]): TriageDecision {
	const hasRole = labels.some((label) => (TRIAGE_ROLES as readonly string[]).includes(label));
	if (hasRole) {
		return { action: "skip" };
	}
	return {
		action: "needs-triage",
		label: "needs-triage",
		comment: buildTriageComment(),
	};
}

export function decide(json: string): TriageDecision {
	let parsed: { labels?: Array<string | { name?: string }> };
	try {
		parsed = JSON.parse(json) as { labels?: Array<string | { name?: string }> };
	} catch {
		throw new Error("triage-cli: stdin is not valid JSON");
	}
	const labels = (parsed.labels ?? [])
		.map((label) => (typeof label === "string" ? label : (label.name ?? "")))
		.filter((name) => name.length > 0);
	return classifyIssue(labels);
}
