import { describe, expect, it } from "vitest";
import {
	buildSweepComment,
	classifySweep,
	decideSweep,
	findLastSweepFingerprint,
	findUnknownLabels,
	type HygieneBranch,
	type HygieneIssue,
	isStaleNeedsTriage,
	SWEEP_SENTINEL,
} from "../../src/core/gh-tooling/hygiene.js";

const NOW = "2026-08-14T00:00:00.000Z";

function issue(overrides: Partial<HygieneIssue> = {}): HygieneIssue {
	return {
		number: 1,
		title: "Issue one",
		labels: ["ready-for-agent"],
		createdAt: "2026-08-10T00:00:00.000Z",
		body: "",
		...overrides,
	};
}

describe("findUnknownLabels", () => {
	it("returns labels outside the ten-label vocabulary", () => {
		expect(findUnknownLabels(["bug", "ready-for-agent", "wayfinder:map", "docs"])).toEqual(["bug", "docs"]);
	});

	it("returns an empty list when every label is in the vocabulary", () => {
		expect(findUnknownLabels(["needs-triage", "wayfinder:task"])).toEqual([]);
	});
});

describe("isStaleNeedsTriage", () => {
	it("is true when needs-triage is older than the threshold", () => {
		expect(
			isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "2026-08-01T00:00:00.000Z" }), NOW, 7),
		).toBe(true);
	});

	it("is false when the issue is fresh", () => {
		expect(
			isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "2026-08-12T00:00:00.000Z" }), NOW, 7),
		).toBe(false);
	});

	it("is false when the role is not needs-triage", () => {
		expect(
			isStaleNeedsTriage(issue({ labels: ["ready-for-agent"], createdAt: "2026-08-01T00:00:00.000Z" }), NOW, 7),
		).toBe(false);
	});

	it("is false when the date cannot be parsed", () => {
		expect(isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "not-a-date" }), NOW, 7)).toBe(false);
	});
});

describe("classifySweep", () => {
	it("reports missing role labels", () => {
		const decision = classifySweep({ issues: [issue({ labels: ["wayfinder:task"] })], branches: [] }, { now: NOW });
		expect(decision.action).toBe("post");
		expect(decision.problems).toHaveLength(1);
		expect(decision.problems[0]?.type).toBe("missing-role");
		expect(decision.problems[0]?.issueNumber).toBe(1);
	});

	it("reports role conflicts", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["needs-triage", "ready-for-agent"] })], branches: [] },
			{ now: NOW },
		);
		expect(decision.problems[0]?.type).toBe("role-conflict");
	});

	it("reports unknown labels", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["ready-for-agent", "bug"] })], branches: [] },
			{ now: NOW },
		);
		expect(decision.problems.some((p) => p.type === "unknown-label")).toBe(true);
	});

	it("reports stale needs-triage", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["needs-triage"], createdAt: "2026-07-01T00:00:00.000Z" })], branches: [] },
			{ now: NOW },
		);
		expect(decision.problems.some((p) => p.type === "stale-needs-triage")).toBe(true);
	});

	it("reports a branch ahead of main that an open issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/semantic-color-integration", ahead: 3, behind: 0 }];
		const decision = classifySweep(
			{ issues: [issue({ body: "Work on feat/semantic-color-integration" })], branches },
			{ now: NOW },
		);
		expect(
			decision.problems.some(
				(p) => p.type === "unmerged-branch" && p.branchName === "feat/semantic-color-integration",
			),
		).toBe(true);
	});

	it("does not report a branch that main already contains", () => {
		const branches: HygieneBranch[] = [{ name: "feat/done", ahead: 0, behind: 12 }];
		const decision = classifySweep({ issues: [issue({ body: "Work on feat/done" })], branches }, { now: NOW });
		expect(decision.problems.some((p) => p.type === "unmerged-branch")).toBe(false);
	});

	it("does not report an ahead branch that no open issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/orphan", ahead: 5, behind: 0 }];
		const decision = classifySweep({ issues: [issue({ body: "unrelated" })], branches }, { now: NOW });
		expect(decision.problems.some((p) => p.type === "unmerged-branch")).toBe(false);
	});

	it("does not report a stale branch that a closed issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/old", ahead: 5, behind: 0 }];
		const decision = classifySweep(
			{ issues: [issue({ state: "CLOSED", body: "Work on feat/old" })], branches },
			{ now: NOW },
		);
		expect(decision.problems.some((p) => p.type === "unmerged-branch")).toBe(false);
	});

	it("does not report a wayfinder label alone as unknown", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["wayfinder:map", "ready-for-agent"] })], branches: [] },
			{ now: NOW },
		);
		expect(decision.problems.some((p) => p.type === "unknown-label")).toBe(false);
	});

	it("returns none with no comment when nothing is wrong", () => {
		const decision = classifySweep({ issues: [issue()], branches: [] }, { now: NOW });
		expect(decision.action).toBe("none");
		expect(decision.problems).toEqual([]);
		expect(decision.comment).toBeUndefined();
	});

	it("skips posting when the previous sweep reported the same problems", () => {
		const input = {
			issues: [issue({ labels: [] })],
			branches: [],
			comments: [`${SWEEP_SENTINEL} - old\n<!-- hygiene-fingerprint: deadbeef -->`],
		};
		const first = classifySweep(input, { now: NOW });
		expect(first.action).toBe("post");
		const second = classifySweep(
			{
				issues: input.issues,
				branches: [],
				comments: [`${SWEEP_SENTINEL} - old\n<!-- hygiene-fingerprint: ${first.fingerprint} -->`],
			},
			{ now: NOW },
		);
		expect(second.action).toBe("skip");
		expect(second.comment).toBeUndefined();
	});

	it("posts when the problem set changed since the previous sweep", () => {
		const input = {
			issues: [issue({ labels: [] })],
			branches: [],
			comments: [`<!-- hygiene-fingerprint: f0000000 -->`],
		};
		expect(classifySweep(input, { now: NOW }).action).toBe("post");
	});
});

describe("findLastSweepFingerprint", () => {
	it("returns the fingerprint of the last sweep comment", () => {
		const comments = [
			`${SWEEP_SENTINEL}<!-- hygiene-fingerprint: aaaaaaaa -->`,
			"a human comment",
			`${SWEEP_SENTINEL}<!-- hygiene-fingerprint: bbbbbbbb -->`,
		];
		expect(findLastSweepFingerprint(comments)).toBe("bbbbbbbb");
	});

	it("returns null when no sweep comment exists", () => {
		expect(findLastSweepFingerprint(["a human comment"])).toBeNull();
	});
});

describe("buildSweepComment", () => {
	it("starts with the sweep sentinel and carries the fingerprint", () => {
		const problems = classifySweep({ issues: [issue({ labels: [] })], branches: [] }, { now: NOW }).problems;
		const fingerprint = "abc123";
		const comment = buildSweepComment(problems, fingerprint, NOW);
		expect(comment.startsWith(SWEEP_SENTINEL)).toBe(true);
		expect(comment).toContain("abc123");
		expect(comment).toContain("#1");
	});
});

describe("decideSweep", () => {
	it("classifies a gh-shaped JSON document", () => {
		const json = JSON.stringify({
			issues: [{ number: 7, title: "T", labels: [], createdAt: "2026-07-01T00:00:00.000Z", body: "" }],
			branches: [],
			comments: [],
		});
		const decision = decideSweep(json);
		expect(decision.action).toBe("post");
		expect(decision.problems.some((p) => p.issueNumber === 7 && p.type === "missing-role")).toBe(true);
	});

	it("throws on invalid JSON", () => {
		expect(() => decideSweep("not json")).toThrow("hygiene-cli: stdin is not valid JSON");
	});
});
