import { describe, expect, it } from "vitest";
import { classifyCompletionFailure, describeCompletionFailure } from "../../src/gateway/completion-failure.js";

describe("classifyCompletionFailure", () => {
	it("marks a SIGTERM exit (143) as transient interrupted", () => {
		const info = classifyCompletionFailure("completion exited with code 143: /opt/bin/cli.js --mode json hi");
		expect(info).toEqual({ kind: "interrupted", transient: true });
	});

	it("marks a SIGKILL exit (137) as transient killed", () => {
		expect(classifyCompletionFailure("completion exited with code 137: /opt/bin/cli.js hi").kind).toBe("killed");
	});

	it("marks a gateway timeout as transient", () => {
		expect(classifyCompletionFailure("completion timed out after 300000ms: /opt/bin/cli.js hi").kind).toBe("timeout");
	});

	it("marks a busy-session error as transient", () => {
		const info = classifyCompletionFailure(
			"completion exited with code 1: /opt/bin/cli.js hi Error: Session is already active in owned-x",
		);
		expect(info.kind).toBe("session_busy");
		expect(info.transient).toBe(true);
	});

	it("marks a spawn failure as transient", () => {
		expect(classifyCompletionFailure("spawn /opt/bin/cli.js ENOENT").kind).toBe("spawn");
		expect(classifyCompletionFailure("spawn /opt/bin/cli.js ENOMEM").transient).toBe(true);
	});

	it("marks unknown failures as non-transient", () => {
		expect(classifyCompletionFailure("completion exited with code 1: some model error")).toEqual({
			kind: "failed",
			transient: false,
		});
	});
});

describe("describeCompletionFailure", () => {
	it("turns each failure kind into one short sentence", () => {
		expect(describeCompletionFailure("completion exited with code 143: /opt/bin/cli.js")).toContain("interrupted");
		expect(describeCompletionFailure("completion exited with code 137: /opt/bin/cli.js")).toContain("stopped");
		expect(describeCompletionFailure("completion timed out after 100ms: /opt/bin/cli.js")).toContain("too long");
		expect(
			describeCompletionFailure("completion exited with code 1: /opt/bin/cli.js Error: Session is already active"),
		).toContain("another run");
		expect(describeCompletionFailure("spawn /opt/bin/cli.js ENOENT")).toContain("could not start");
		expect(describeCompletionFailure("completion exited with code 1: bad prompt")).toContain("failed");
	});

	it("never leaks the command line or session id into the user-facing text", () => {
		const raw =
			"completion exited with code 143: /home/user/.axiom/dist/bundle/cli.js --mode json Yes --profile default --session-id gw-a149f075 --compact-before";
		const text = describeCompletionFailure(raw);
		expect(text).not.toContain("cli.js");
		expect(text).not.toContain("gw-a149f075");
		expect(text).not.toContain("--mode");
		expect(text.length).toBeLessThan(120);
	});
});
