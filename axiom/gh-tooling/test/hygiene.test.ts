import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildSweepComment,
	classifySweep,
	decideSweep,
	findLastSweepFingerprint,
	findUnknownLabels,
	isStaleNeedsTriage,
	SWEEP_SENTINEL,
} from "../src/hygiene.ts";
import type { HygieneBranch, HygieneIssue } from "../src/hygiene.ts";

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
		assert.deepEqual(findUnknownLabels(["bug", "ready-for-agent", "wayfinder:map", "docs"]), ["bug", "docs"]);
	});

	it("returns an empty list when every label is in the vocabulary", () => {
		assert.deepEqual(findUnknownLabels(["needs-triage", "wayfinder:task"]), []);
	});
});

describe("isStaleNeedsTriage", () => {
	it("is true when needs-triage is older than the threshold", () => {
		assert.equal(
			isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "2026-08-01T00:00:00.000Z" }), NOW, 7),
			true,
		);
	});

	it("is false when the issue is fresh", () => {
		assert.equal(
			isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "2026-08-12T00:00:00.000Z" }), NOW, 7),
			false,
		);
	});

	it("is false when the role is not needs-triage", () => {
		assert.equal(
			isStaleNeedsTriage(issue({ labels: ["ready-for-agent"], createdAt: "2026-08-01T00:00:00.000Z" }), NOW, 7),
			false,
		);
	});

	it("is false when the date cannot be parsed", () => {
		assert.equal(isStaleNeedsTriage(issue({ labels: ["needs-triage"], createdAt: "not-a-date" }), NOW, 7), false);
	});
});

describe("classifySweep", () => {
	it("reports missing role labels", () => {
		const decision = classifySweep({ issues: [issue({ labels: ["wayfinder:task"] })], branches: [] }, { now: NOW });
		assert.equal(decision.action, "post");
		assert.equal(decision.problems.length, 1);
		assert.equal(decision.problems[0]?.type, "missing-role");
		assert.equal(decision.problems[0]?.issueNumber, 1);
	});

	it("reports role conflicts", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["needs-triage", "ready-for-agent"] })], branches: [] },
			{ now: NOW },
		);
		assert.equal(decision.problems[0]?.type, "role-conflict");
	});

	it("reports unknown labels", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["ready-for-agent", "bug"] })], branches: [] },
			{ now: NOW },
		);
		assert.equal(decision.problems.some((p) => p.type === "unknown-label"), true);
	});

	it("reports stale needs-triage", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["needs-triage"], createdAt: "2026-07-01T00:00:00.000Z" })], branches: [] },
			{ now: NOW },
		);
		assert.equal(decision.problems.some((p) => p.type === "stale-needs-triage"), true);
	});

	it("reports a branch ahead of main that an open issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/semantic-color-integration", ahead: 3, behind: 0 }];
		const decision = classifySweep(
			{ issues: [issue({ body: "Work on feat/semantic-color-integration" })], branches },
			{ now: NOW },
		);
		assert.equal(
			decision.problems.some(
				(p) => p.type === "unmerged-branch" && p.branchName === "feat/semantic-color-integration",
			),
			true,
		);
	});

	it("does not report a branch that main already contains", () => {
		const branches: HygieneBranch[] = [{ name: "feat/done", ahead: 0, behind: 12 }];
		const decision = classifySweep({ issues: [issue({ body: "Work on feat/done" })], branches }, { now: NOW });
		assert.equal(decision.problems.some((p) => p.type === "unmerged-branch"), false);
	});

	it("does not report an ahead branch that no open issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/orphan", ahead: 5, behind: 0 }];
		const decision = classifySweep({ issues: [issue({ body: "unrelated" })], branches }, { now: NOW });
		assert.equal(decision.problems.some((p) => p.type === "unmerged-branch"), false);
	});

	it("does not report a stale branch that a closed issue references", () => {
		const branches: HygieneBranch[] = [{ name: "feat/old", ahead: 5, behind: 0 }];
		const decision = classifySweep(
			{ issues: [issue({ state: "CLOSED", body: "Work on feat/old" })], branches },
			{ now: NOW },
		);
		assert.equal(decision.problems.some((p) => p.type === "unmerged-branch"), false);
	});

	it("does not report a wayfinder label alone as unknown", () => {
		const decision = classifySweep(
			{ issues: [issue({ labels: ["wayfinder:map", "ready-for-agent"] })], branches: [] },
			{ now: NOW },
		);
		assert.equal(decision.problems.some((p) => p.type === "unknown-label"), false);
	});

	it("returns none with no comment when nothing is wrong", () => {
		const decision = classifySweep({ issues: [issue()], branches: [] }, { now: NOW });
		assert.equal(decision.action, "none");
		assert.deepEqual(decision.problems, []);
		assert.equal(decision.comment, undefined);
	});

	it("skips posting when the previous sweep reported the same problems", () => {
		const input = {
			issues: [issue({ labels: [] })],
			branches: [],
			comments: [`${SWEEP_SENTINEL} - old\n<!-- hygiene-fingerprint: deadbeef -->`],
		};
		const first = classifySweep(input, { now: NOW });
		assert.equal(first.action, "post");
		const second = classifySweep(
			{
				issues: input.issues,
				branches: [],
				comments: [`${SWEEP_SENTINEL} - old\n<!-- hygiene-fingerprint: ${first.fingerprint} -->`],
			},
			{ now: NOW },
		);
		assert.equal(second.action, "skip");
		assert.equal(second.comment, undefined);
	});

	it("posts when the problem set changed since the previous sweep", () => {
		const input = {
			issues: [issue({ labels: [] })],
			branches: [],
			comments: [`<!-- hygiene-fingerprint: f0000000 -->`],
		};
		assert.equal(classifySweep(input, { now: NOW }).action, "post");
	});
});

describe("findLastSweepFingerprint", () => {
	it("returns the fingerprint of the last sweep comment", () => {
		const comments = [
			`${SWEEP_SENTINEL}<!-- hygiene-fingerprint: aaaaaaaa -->`,
			"a human comment",
			`${SWEEP_SENTINEL}<!-- hygiene-fingerprint: bbbbbbbb -->`,
		];
		assert.equal(findLastSweepFingerprint(comments), "bbbbbbbb");
	});

	it("returns null when no sweep comment exists", () => {
		assert.equal(findLastSweepFingerprint(["a human comment"]), null);
	});
});

describe("buildSweepComment", () => {
	it("starts with the sweep sentinel and carries the fingerprint", () => {
		const problems = classifySweep({ issues: [issue({ labels: [] })], branches: [] }, { now: NOW }).problems;
		const fingerprint = "abc123";
		const comment = buildSweepComment(problems, fingerprint, NOW);
		assert.equal(comment.startsWith(SWEEP_SENTINEL), true);
		assert.ok(comment.includes("abc123"));
		assert.ok(comment.includes("#1"));
	});

	it("points at the axiom docs path, not the prime-era path", () => {
		const problems = classifySweep({ issues: [issue({ labels: [] })], branches: [] }, { now: NOW }).problems;
		const comment = buildSweepComment(problems, "abc123", NOW);
		// The missing-role detail names the triage-labels doc; ensure it is re-anchored.
		assert.ok(comment.includes("axiom/docs/agents/triage-labels.md"));
		assert.equal(/(^|[^a-z/])docs\/agents\/triage-labels\.md/.test(comment), false);
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
		assert.equal(decision.action, "post");
		assert.equal(decision.problems.some((p) => p.issueNumber === 7 && p.type === "missing-role"), true);
	});

	it("throws on invalid JSON", () => {
		assert.throws(() => decideSweep("not json"), /hygiene-cli: stdin is not valid JSON/);
	});
});
