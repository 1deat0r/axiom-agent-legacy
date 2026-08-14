import { describe, expect, it } from "vitest";
import {
	ALL_LABELS,
	AUDIT_MARKERS,
	buildCloseNudge,
	buildTriageComment,
	classifyClose,
	classifyOpen,
	decide,
	decideClose,
	TRIAGE_ROLES,
	WAYFINDER_LABELS,
} from "../../src/core/gh-tooling/triage.js";

describe("TRIAGE_ROLES", () => {
	it("holds the five canonical roles in order", () => {
		expect(TRIAGE_ROLES).toEqual(["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]);
	});
});

describe("classifyOpen", () => {
	it("returns needs-triage on opened with no labels", () => {
		const decision = classifyOpen([], "opened");
		expect(decision.action).toBe("needs-triage");
		expect(decision.label).toBe("needs-triage");
		expect(decision.comment).toBeTruthy();
	});

	it("returns skip on opened when any role label is present", () => {
		for (const role of TRIAGE_ROLES) {
			expect(classifyOpen([role], "opened").action).toBe("skip");
		}
	});

	it("returns skip on opened when a role label sits beside other labels", () => {
		expect(classifyOpen(["wayfinder:map", "ready-for-agent"], "opened").action).toBe("skip");
	});

	it("treats wayfinder labels alone as unlabeled", () => {
		expect(classifyOpen(["wayfinder:map"], "opened").action).toBe("needs-triage");
	});

	it("ignores unknown labels", () => {
		expect(classifyOpen(["bug", "enhancement"], "opened").action).toBe("needs-triage");
	});

	it("never emits a comment on skip", () => {
		expect(classifyOpen(["needs-triage"], "opened").comment).toBeUndefined();
	});

	it("returns role-conflict on labeled with two role labels", () => {
		const decision = classifyOpen(["needs-triage", "ready-for-agent"], "labeled");
		expect(decision.action).toBe("role-conflict");
		expect(decision.comment).toContain("needs-triage");
		expect(decision.comment).toContain("ready-for-agent");
	});

	it("returns skip on labeled with one role label", () => {
		expect(classifyOpen(["ready-for-agent"], "labeled").action).toBe("skip");
	});

	it("returns needs-triage on labeled when no role label is present", () => {
		expect(classifyOpen(["wayfinder:task"], "labeled").action).toBe("needs-triage");
	});

	it("returns remind on unlabeled with no role label and does not re-apply", () => {
		const decision = classifyOpen([], "unlabeled");
		expect(decision.action).toBe("remind");
		expect(decision.label).toBeUndefined();
		expect(decision.comment).toBeTruthy();
	});

	it("returns skip on unlabeled when a role label remains", () => {
		expect(classifyOpen(["ready-for-agent"], "unlabeled").action).toBe("skip");
	});
});

describe("buildTriageComment", () => {
	it("names the five parts of the readiness contract", () => {
		const comment = buildTriageComment();
		for (const part of ["Goal", "Acceptance criteria", "Scope", "ADR status", "Verification plan"]) {
			expect(comment).toContain(part);
		}
	});

	it("names the applied label and the target label", () => {
		const comment = buildTriageComment();
		expect(comment).toContain("needs-triage");
		expect(comment).toContain("ready-for-agent");
	});
});

describe("decide", () => {
	it("parses gh issue view --json labels output", () => {
		const decision = decide('{"labels":[{"name":"needs-triage"}]}', "opened");
		expect(decision.action).toBe("skip");
	});

	it("treats an empty labels array as unlabeled", () => {
		const decision = decide('{"labels":[]}', "opened");
		expect(decision.action).toBe("needs-triage");
	});

	it("treats missing labels as unlabeled", () => {
		const decision = decide("{}", "opened");
		expect(decision.action).toBe("needs-triage");
	});
});

describe("ALL_LABELS", () => {
	it("is exactly the ten-label vocabulary", () => {
		expect(ALL_LABELS).toHaveLength(10);
		expect(ALL_LABELS).toEqual([...TRIAGE_ROLES, ...WAYFINDER_LABELS]);
	});
});

describe("classifyClose", () => {
	it("nudges when no comments are present", () => {
		const decision = classifyClose([]);
		expect(decision.action).toBe("nudge");
		expect(decision.comment).toBeTruthy();
	});

	it("skips when one comment carries all three audit markers", () => {
		const audit = "Landed. Commit: abc ADR: docs/adr/ADR-0050.md Handoff: docs/handoff.md Verified: tests";
		expect(classifyClose([{ body: audit }]).action).toBe("skip");
	});

	it("nudges when the markers spread across comments", () => {
		const decision = classifyClose([{ body: "Commit: abc" }, { body: "ADR: x Handoff: y" }]);
		expect(decision.action).toBe("nudge");
	});

	it("skips when a prior nudge comment exists", () => {
		expect(classifyClose([{ body: "This issue closed without the audit comment." }]).action).toBe("skip");
	});

	it("never emits a comment on skip", () => {
		expect(classifyClose([{ body: "Commit: a ADR: b Handoff: c" }]).comment).toBeUndefined();
	});
});

describe("buildCloseNudge", () => {
	it("names the three audit artifacts and the doc", () => {
		const nudge = buildCloseNudge();
		for (const part of ["merge commit", "ADR", "handoff", "docs/agents/issue-tracker.md"]) {
			expect(nudge).toContain(part);
		}
	});
});

describe("decideClose", () => {
	it("parses gh issue view --json comments output", () => {
		const decision = decideClose('{"comments":[{"body":"Commit: a ADR: b Handoff: c"}]}');
		expect(decision.action).toBe("skip");
	});

	it("nudges when the comments array is empty", () => {
		expect(decideClose('{"comments":[]}').action).toBe("nudge");
	});
});

describe("AUDIT_MARKERS", () => {
	it("is the three close-ritual fields", () => {
		expect(AUDIT_MARKERS).toEqual(["Commit:", "ADR:", "Handoff:"]);
	});
});
