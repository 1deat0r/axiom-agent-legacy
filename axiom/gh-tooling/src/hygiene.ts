import { ALL_LABELS, findRoleLabels } from "./triage.ts";

export const SWEEP_SENTINEL = "Issue hygiene sweep";
export const FINGERPRINT_PREFIX = "<!-- hygiene-fingerprint:";
export const STALE_NEEDS_TRIAGE_DAYS_DEFAULT = 7;

export type HygieneProblemType =
	| "missing-role"
	| "role-conflict"
	| "unknown-label"
	| "stale-needs-triage"
	| "unmerged-branch";

export interface HygieneIssue {
	number: number;
	title: string;
	labels: string[];
	createdAt: string;
	body?: string;
	state?: string;
}

export interface HygieneBranch {
	name: string;
	ahead: number;
	behind: number;
}

export interface HygieneProblem {
	type: HygieneProblemType;
	issueNumber: number;
	issueTitle: string;
	detail: string;
	branchName?: string;
}

export interface SweepInput {
	issues: HygieneIssue[];
	branches: HygieneBranch[];
	comments?: string[];
	now?: string;
}

export interface SweepOptions {
	now?: string;
	staleDays?: number;
}

export interface SweepDecision {
	action: "post" | "skip" | "none";
	comment?: string;
	fingerprint?: string;
	problems: HygieneProblem[];
}

export function findUnknownLabels(labels: readonly string[]): string[] {
	return labels.filter((label) => !ALL_LABELS.includes(label));
}

const DAY_MS = 86_400_000;

export function isStaleNeedsTriage(issue: HygieneIssue, nowIso: string, staleDays: number): boolean {
	if (!findRoleLabels(issue.labels).includes("needs-triage")) {
		return false;
	}
	const createdAt = Date.parse(issue.createdAt);
	const now = Date.parse(nowIso);
	if (Number.isNaN(createdAt) || Number.isNaN(now)) {
		return false;
	}
	return createdAt + staleDays * DAY_MS <= now;
}

function collectIssueProblems(issue: HygieneIssue, nowIso: string, staleDays: number): HygieneProblem[] {
	const problems: HygieneProblem[] = [];
	const roles = findRoleLabels(issue.labels);
	if (roles.length === 0) {
		problems.push({
			type: "missing-role",
			issueNumber: issue.number,
			issueTitle: issue.title,
			detail: "No role label (axiom/docs/agents/triage-labels.md).",
		});
	} else if (roles.length > 1) {
		problems.push({
			type: "role-conflict",
			issueNumber: issue.number,
			issueTitle: issue.title,
			detail: `Multiple role labels: ${roles.join(", ")}.`,
		});
	}
	const unknown = findUnknownLabels(issue.labels);
	if (unknown.length > 0) {
		problems.push({
			type: "unknown-label",
			issueNumber: issue.number,
			issueTitle: issue.title,
			detail: `Labels outside the vocabulary: ${unknown.join(", ")}.`,
		});
	}
	if (isStaleNeedsTriage(issue, nowIso, staleDays)) {
		const days = Math.floor((Date.parse(nowIso) - Date.parse(issue.createdAt)) / DAY_MS);
		problems.push({
			type: "stale-needs-triage",
			issueNumber: issue.number,
			issueTitle: issue.title,
			detail: `needs-triage for ${days} days.`,
		});
	}
	return problems;
}

function collectBranchProblems(openIssues: HygieneIssue[], branches: HygieneBranch[]): HygieneProblem[] {
	const problems: HygieneProblem[] = [];
	for (const branch of branches) {
		if (branch.ahead <= 0) {
			continue;
		}
		const referencing = openIssues.filter((candidate) => (candidate.body ?? "").includes(branch.name));
		for (const issue of referencing) {
			problems.push({
				type: "unmerged-branch",
				issueNumber: issue.number,
				issueTitle: issue.title,
				detail: `Branch ${branch.name} is ${branch.ahead} commit${branch.ahead === 1 ? "" : "s"} ahead of main.`,
				branchName: branch.name,
			});
		}
	}
	return problems;
}

export function buildFingerprint(problems: HygieneProblem[]): string {
	const sorted = [...problems].sort(
		(a, b) => a.type.localeCompare(b.type) || a.issueNumber - b.issueNumber || a.detail.localeCompare(b.detail),
	);
	let hash = 5381;
	for (const problem of sorted) {
		const line = `${problem.type}:${problem.issueNumber}:${problem.detail}`;
		for (let i = 0; i < line.length; i++) {
			hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
		}
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

const FINGERPRINT_PATTERN = /<!--\s*hygiene-fingerprint:\s*([0-9a-f]{8})\s*-->/g;

export function findLastSweepFingerprint(comments: readonly string[]): string | null {
	let found: string | null = null;
	for (const body of comments) {
		if (!body.includes(SWEEP_SENTINEL)) {
			continue;
		}
		for (const match of body.matchAll(FINGERPRINT_PATTERN)) {
			found = match[1] ?? null;
		}
	}
	return found;
}

export function buildSweepComment(problems: HygieneProblem[], fingerprint: string, nowIso: string): string {
	const date = nowIso.slice(0, 10);
	const lines: string[] = [];
	lines.push(`${SWEEP_SENTINEL} - ${date}`);
	lines.push("");
	lines.push(`${problems.length} problem${problems.length === 1 ? "" : "s"} found.`);
	lines.push("");
	for (const problem of problems) {
		lines.push(`- #${problem.issueNumber} ${problem.issueTitle}: ${problem.detail}`);
	}
	lines.push("");
	lines.push("Fix the labels and merge or delete the stale branches, then the next sweep stays quiet.");
	lines.push("");
	lines.push(`${FINGERPRINT_PREFIX} ${fingerprint} -->`);
	return lines.join("\n");
}

export function classifySweep(input: SweepInput, options: SweepOptions = {}): SweepDecision {
	const nowIso = options.now ?? input.now ?? new Date().toISOString();
	const staleDays = options.staleDays ?? STALE_NEEDS_TRIAGE_DAYS_DEFAULT;
	const openIssues = input.issues.filter((candidate) => (candidate.state ?? "OPEN") !== "CLOSED");
	const problems = [
		...openIssues.flatMap((candidate) => collectIssueProblems(candidate, nowIso, staleDays)),
		...collectBranchProblems(openIssues, input.branches),
	];
	if (problems.length === 0) {
		return { action: "none", problems: [] };
	}
	const fingerprint = buildFingerprint(problems);
	const previous = findLastSweepFingerprint(input.comments ?? []);
	if (previous === fingerprint) {
		return { action: "skip", problems, fingerprint };
	}
	return { action: "post", comment: buildSweepComment(problems, fingerprint, nowIso), problems, fingerprint };
}

export interface SweepJsonIssue extends Omit<HygieneIssue, "labels"> {
	labels?: Array<string | { name?: string }>;
}

export function decideSweep(json: string): SweepDecision {
	let parsed: {
		issues?: SweepJsonIssue[];
		branches?: HygieneBranch[];
		comments?: string[];
	};
	try {
		parsed = JSON.parse(json) as {
			issues?: SweepJsonIssue[];
			branches?: HygieneBranch[];
			comments?: string[];
		};
	} catch {
		throw new Error("hygiene-cli: stdin is not valid JSON");
	}
	const issues = (parsed.issues ?? []).map((entry) => ({
		number: entry.number,
		title: entry.title,
		labels: (entry.labels ?? [])
			.map((label) => (typeof label === "string" ? label : (label.name ?? "")))
			.filter((name) => name.length > 0),
		createdAt: entry.createdAt,
		body: entry.body ?? "",
		state: entry.state,
	}));
	const branches = (parsed.branches ?? []).map((entry) => ({
		name: entry.name,
		ahead: entry.ahead,
		behind: entry.behind,
	}));
	return classifySweep({ issues, branches, comments: parsed.comments ?? [] });
}
