// P1-TASK-3: red tests for the "# Parallel tool calls" guidance block in
// buildRlmPrompt (packages/coding-agent/src/core/prompts/rlm.ts).
//
// Intended behavior once the feature lands: the prompt gains guidance that
// (1) instructs batching independent tool calls into one assistant response,
// (2) carries an accuracy caveat about ipython / serialized execution, and
// (3) references concurrency / fewer round-trips. The existing iteration and
// final-answer guidance must survive.
//
// Assertions are deliberately loose regex matches (case-insensitive key
// phrases) so the exact wording of the block can vary. Self-contained: no
// fixtures, no imports beyond vitest and the module under test.

import { describe, expect, test } from "vitest";
import { buildRlmPrompt } from "../src/core/prompts/index.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

/** Minimal build options; all optional fields defaulted. */
function minimalPrompt(): string {
	return buildRlmPrompt({ cwd: "/x", messagesPath: "/x" });
}

describe("buildRlmPrompt parallel tool calls guidance", () => {
	test("includes a parallel tool calls guidance section", () => {
		const prompt = minimalPrompt();
		expect(prompt).toMatch(/parallel tool calls/i);
		expect(prompt).toMatch(/single response|together|batch/i);
	});

	test("instructs batching independent tool calls into one assistant response", () => {
		const prompt = minimalPrompt();
		expect(prompt).toMatch(/independent/i);
		expect(prompt).toMatch(
			/single (assistant )?(response|message|turn)|batch|together|same (assistant )?(response|message|turn)/i,
		);
	});

	test("cautions that batched calls may execute serially in ipython", () => {
		const prompt = minimalPrompt();
		expect(prompt).toMatch(/ipython/i);
		expect(prompt).toMatch(
			/serial|sequential|one at a time|one by one|in order|not (necessarily |actually )?parallel/i,
		);
	});

	test("places the accuracy caveat inside the guidance block", () => {
		const prompt = minimalPrompt();
		const heading = prompt.search(/parallel tool calls/i);
		expect(heading).toBeGreaterThanOrEqual(0);
		const tail = prompt.slice(heading);
		expect(tail).toMatch(/ipython/i);
		expect(tail).toMatch(
			/serial|sequential|one at a time|one by one|in order|not (necessarily |actually )?parallel/i,
		);
	});

	test("references concurrency or fewer round-trips", () => {
		const prompt = minimalPrompt();
		expect(prompt).toMatch(/concurren|round.?trips?|fewer (turns|messages|round)/i);
	});

	test("preserves the existing iteration guidance", () => {
		const prompt = minimalPrompt();
		expect(prompt).toContain(
			"You solve tasks by breaking down problems into sub-tasks, writing and executing code, observing results, and iterating until the task is done.",
		);
	});

	test("still instructs final-answer stopping", () => {
		const prompt = minimalPrompt();
		expect(prompt).toContain("When you are done, stop calling tools and state your final answer.");
	});

	test("keeps the working-directory and conversation-log anchors", () => {
		const prompt = minimalPrompt();
		expect(prompt).toContain("Working directory: /x");
		expect(prompt).toContain("Conversation log: /x");
	});
});

describe("buildSystemPrompt custom prompt path", () => {
	test("appends the parallel tool calls guidance to a custom prompt", () => {
		const prompt = buildSystemPrompt({ customPrompt: "Be concise.", cwd: "/x" });
		expect(prompt).toMatch(/parallel tool calls/i);
		expect(prompt).toMatch(/concurren|round.?trips?/i);
	});

	test("carries the ipython caveat in the custom prompt path", () => {
		const prompt = buildSystemPrompt({ customPrompt: "Be concise.", cwd: "/x" });
		expect(prompt).toMatch(/ipython/i);
		expect(prompt).toMatch(/serial|sequential|one at a time|in order/i);
	});
});
