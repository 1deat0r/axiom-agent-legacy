import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
} from "../src/triage.ts";

describe("TRIAGE_ROLES", () => {
	it("holds the five canonical roles in order", () => {
		assert.deepEqual(TRIAGE_ROLES, ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]);
	});
});

describe("classifyOpen", () => {
	it("returns needs-triage on opened with no labels", () => {
		const decision = classifyOpen([], "opened");
		assert.equal(decision.action, "needs-triage");
		assert.equal(decision.label, "needs-triage");
		assert.ok(decision.comment);
	});

	it("returns skip on opened when any role label is present", () => {
		for (const role of TRIAGE_ROLES) {
			assert.equal(classifyOpen([role], "opened").action, "skip");
		}
	});

	it("returns skip on opened when a role label sits beside other labels", () => {
		assert.equal(classifyOpen(["wayfinder:map", "ready-for-agent"], "opened").action, "skip");
	});

	it("treats wayfinder labels alone as unlabeled", () => {
		assert.equal(classifyOpen(["wayfinder:map"], "opened").action, "needs-triage");
	});

	it("ignores unknown labels", () => {
		assert.equal(classifyOpen(["bug", "enhancement"], "opened").action, "needs-triage");
	});

	it("never emits a comment on skip", () => {
		assert.equal(classifyOpen(["needs-triage"], "opened").comment, undefined);
	});

	it("returns role-conflict on labeled with two role labels", () => {
		const decision = classifyOpen(["needs-triage", "ready-for-agent"], "labeled");
		assert.equal(decision.action, "role-conflict");
		assert.ok(decision.comment?.includes("needs-triage"));
		assert.ok(decision.comment?.includes("ready-for-agent"));
	});

	it("returns skip on labeled with one role label", () => {
		assert.equal(classifyOpen(["ready-for-agent"], "labeled").action, "skip");
	});

	it("returns needs-triage on labeled when no role label is present", () => {
		assert.equal(classifyOpen(["wayfinder:task"], "labeled").action, "needs-triage");
	});

	it("returns remind on unlabeled with no role label and does not re-apply", () => {
		const decision = classifyOpen([], "unlabeled");
		assert.equal(decision.action, "remind");
		assert.equal(decision.label, undefined);
		assert.ok(decision.comment);
	});

	it("the remind comment never claims the workflow applied a label", () => {
		const decision = classifyOpen([], "unlabeled");
		assert.ok(!decision.comment?.includes("The workflow applied"));
		assert.ok(decision.comment?.includes("does not re-apply"));
	});

	it("returns skip on unlabeled when a role label remains", () => {
		assert.equal(classifyOpen(["ready-for-agent"], "unlabeled").action, "skip");
	});

	it("suppresses the contract comment when the bot already posted it", () => {
		const decision = classifyOpen([], "opened", ["The workflow applied `needs-triage`."]);
		assert.equal(decision.action, "needs-triage");
		assert.equal(decision.label, "needs-triage");
		assert.equal(decision.comment, undefined);
	});

	it("suppresses the remind comment when the bot already posted it", () => {
		const decision = classifyOpen([], "unlabeled", ["The workflow does not re-apply labels on removal."]);
		assert.equal(decision.action, "skip");
	});

	it("skips the open job on closed issues for label events", () => {
		assert.equal(classifyOpen(["needs-triage", "ready-for-agent"], "labeled", [], "CLOSED").action, "skip");
		assert.equal(classifyOpen([], "unlabeled", [], "CLOSED").action, "skip");
	});

	it("does not skip the open job on open issues", () => {
		assert.equal(
			classifyOpen(["needs-triage", "ready-for-agent"], "labeled", [], "OPEN").action,
			"role-conflict",
		);
	});
});

describe("buildTriageComment", () => {
	it("names the five parts of the readiness contract", () => {
		const comment = buildTriageComment();
		for (const part of ["Goal", "Acceptance criteria", "Scope", "ADR status", "Verification plan"]) {
			assert.ok(comment.includes(part));
		}
	});

	it("names the applied label and the target label", () => {
		const comment = buildTriageComment();
		assert.ok(comment.includes("needs-triage"));
		assert.ok(comment.includes("ready-for-agent"));
	});

	it("points at the axiom docs path, not the prime-era path", () => {
		const comment = buildTriageComment();
		assert.ok(comment.includes("axiom/docs/agents/triage-labels.md"));
		// The bare prime-era path must never appear without the axiom/ prefix.
		assert.equal(/(^|[^a-z/])docs\/agents\/triage-labels\.md/.test(comment), false);
	});

	it("names this baseline's verification tools, not the prime-era ones", () => {
		const comment = buildTriageComment();
		assert.ok(comment.includes("scripts/run_tests.sh"));
		assert.ok(comment.includes("node --test"));
		assert.ok(!comment.includes("tsgo"));
		assert.ok(!comment.includes("biome"));
	});
});

describe("decide", () => {
	it("parses gh issue view --json labels output", () => {
		const decision = decide('{"labels":[{"name":"needs-triage"}]}', "opened");
		assert.equal(decision.action, "skip");
	});

	it("parses labels, comments, and state in one payload", () => {
		const json = '{"labels":[],"comments":[{"body":"The workflow applied `needs-triage`."}],"state":"OPEN"}';
		const decision = decide(json, "opened");
		assert.equal(decision.action, "needs-triage");
		assert.equal(decision.comment, undefined);
	});

	it("skips label events on closed issues", () => {
		const json = '{"labels":[],"comments":[],"state":"CLOSED"}';
		assert.equal(decide(json, "labeled").action, "skip");
	});

	it("treats an empty labels array as unlabeled", () => {
		const decision = decide('{"labels":[]}', "opened");
		assert.equal(decision.action, "needs-triage");
	});

	it("treats missing labels as unlabeled", () => {
		const decision = decide("{}", "opened");
		assert.equal(decision.action, "needs-triage");
	});

	it("throws on invalid JSON", () => {
		assert.throws(() => decide("not json", "opened"), /not valid JSON/);
	});
});

describe("ALL_LABELS", () => {
	it("is exactly the ten-label vocabulary", () => {
		assert.equal(ALL_LABELS.length, 10);
		assert.deepEqual(ALL_LABELS, [...TRIAGE_ROLES, ...WAYFINDER_LABELS]);
	});
});

describe("classifyClose", () => {
	it("nudges when no comments are present", () => {
		const decision = classifyClose([]);
		assert.equal(decision.action, "nudge");
		assert.ok(decision.comment);
	});

	it("skips when one comment carries all three audit markers", () => {
		const audit = "Landed. Commit: abc ADR: axiom/docs/adr/ADR-0050.md Handoff: axiom/docs/handoff.md Verified: tests";
		assert.equal(classifyClose([{ body: audit }]).action, "skip");
	});

	it("nudges when the markers spread across comments", () => {
		const decision = classifyClose([{ body: "Commit: abc" }, { body: "ADR: x Handoff: y" }]);
		assert.equal(decision.action, "nudge");
	});

	it("skips when a prior nudge comment exists", () => {
		assert.equal(classifyClose([{ body: "This issue closed without the audit comment." }]).action, "skip");
	});

	it("never emits a comment on skip", () => {
		assert.equal(classifyClose([{ body: "Commit: a ADR: b Handoff: c" }]).comment, undefined);
	});
});

describe("buildCloseNudge", () => {
	it("names the three audit artifacts and the doc", () => {
		const nudge = buildCloseNudge();
		for (const part of ["merge commit", "ADR", "handoff", "axiom/docs/agents/issue-tracker.md"]) {
			assert.ok(nudge.includes(part));
		}
	});
});

describe("decideClose", () => {
	it("parses gh issue view --json comments output", () => {
		const decision = decideClose('{"comments":[{"body":"Commit: a ADR: b Handoff: c"}]}');
		assert.equal(decision.action, "skip");
	});

	it("nudges when the comments array is empty", () => {
		assert.equal(decideClose('{"comments":[]}').action, "nudge");
	});

	it("throws on invalid JSON", () => {
		assert.throws(() => decideClose("not json"), /not valid JSON/);
	});
});

describe("AUDIT_MARKERS", () => {
	it("is the three close-ritual fields", () => {
		assert.deepEqual(AUDIT_MARKERS, ["Commit:", "ADR:", "Handoff:"]);
	});
});
