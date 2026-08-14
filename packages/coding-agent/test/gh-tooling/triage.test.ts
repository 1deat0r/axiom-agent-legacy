import { describe, expect, it } from "vitest";
import {
	ALL_LABELS,
	AUDIT_MARKERS,
	buildCloseNudge,
	buildTriageComment,
	classifyClose,
	classifyIssue,
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

describe("classifyIssue", () => {
	it("returns needs-triage when no labels are present", () => {
		const decision = classifyIssue([]);
		expect(decision.action).toBe("needs-triage");
		expect(decision.label).toBe("needs-triage");
		expect(decision.comment).toBeTruthy();
	});

	it("returns skip when any role label is present", () => {
		for (const role of TRIAGE_ROLES) {
			expect(classifyIssue([role]).action).toBe("skip");
		}
	});

	it("returns skip when a role label sits beside other labels", () => {
		expect(classifyIssue(["wayfinder:map", "ready-for-agent"]).action).toBe("skip");
	});

	it("ignores wayfinder labels alone", () => {
		expect(classifyIssue(["wayfinder:map"]).action).toBe("needs-triage");
	});

	it("ignores unknown labels", () => {
		expect(classifyIssue(["bug", "enhancement"]).action).toBe("needs-triage");
	});

	it("never emits a comment on skip", () => {
		expect(classifyIssue(["needs-triage"]).comment).toBeUndefined();
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
		const decision = decide('{"labels":[{"name":"needs-triage"}]}');
		expect(decision.action).toBe("skip");
	});

	it("treats an empty labels array as unlabeled", () => {
		const decision = decide('{"labels":[]}');
		expect(decision.action).toBe("needs-triage");
	});

	it("treats missing labels as unlabeled", () => {
		const decision = decide("{}");
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
