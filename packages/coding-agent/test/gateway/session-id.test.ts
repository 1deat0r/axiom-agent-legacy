import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";
import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

describe("parseArgs --session-id", () => {
	it("parses --session-id <id> into the sessionId field, not unknownFlags", () => {
		const result = parseArgs(["-p", "hello", "--session-id", "gw-abc"]);
		expect(result.sessionId).toBe("gw-abc");
		expect(result.unknownFlags.has("--session-id")).toBe(false);
	});

	it("parses --session-id=<id>", () => {
		const result = parseArgs(["--session-id=gw-def", "-p", "hi"]);
		expect(result.sessionId).toBe("gw-def");
		expect(result.unknownFlags.has("--session-id")).toBe(false);
	});

	it("ignores --session-id for other flags and leaves prompts intact", () => {
		const result = parseArgs(["-p", "say hi", "--session-id", "gw-abc", "more"]);
		expect(result.sessionId).toBe("gw-abc");
		expect(result.print).toBe(true);
		expect(result.messages).toEqual(["say hi", "more"]);
	});

	it("records a diagnostic when --session-id has no value", () => {
		const result = parseArgs(["--session-id"]);
		expect(result.sessionId).toBeUndefined();
		expect(result.diagnostics.some((d) => d.type === "error")).toBe(true);
	});
});

describe("SessionManager.openOrCreateById", () => {
	const freshDir = () => mkdtempSync(join(tmpdir(), "axiom-gw-sid-"));

	it("keys a new session to a stable <id>.jsonl file under the session dir", () => {
		const dir = freshDir();
		const s = SessionManager.openOrCreateById("gw-abc", "/tmp/work", dir);
		expect(s.getSessionFile()).toBe(join(dir, "gw-abc.jsonl"));
	});

	it("keeps different ids isolated in distinct session files", () => {
		const dir = freshDir();
		const a = SessionManager.openOrCreateById("gw-a", "/tmp/work", dir);
		const b = SessionManager.openOrCreateById("gw-b", "/tmp/work", dir);
		expect(a.getSessionFile()).toBe(join(dir, "gw-a.jsonl"));
		expect(b.getSessionFile()).toBe(join(dir, "gw-b.jsonl"));
		expect(a.getSessionFile()).not.toBe(b.getSessionFile());
	});

	it("reopens the exact same conversation when the same id is supplied again", () => {
		const dir = freshDir();
		const cwd = "/tmp/work";
		const one = SessionManager.openOrCreateById("gw-abc", cwd, dir);
		one.appendMessage({
			role: "user",
			content: [{ type: "text", text: "remember: token=alpha" }],
			timestamp: Date.now(),
		});
		// Force-write (pre-assistant entries are held by the no-assistant guard).
		one.flushNow();
		const file = join(dir, "gw-abc.jsonl");
		expect(existsSync(file)).toBe(true);

		const reopened = SessionManager.openOrCreateById("gw-abc", cwd, dir);
		expect(reopened.getSessionFile()).toBe(file);
		const entries = loadEntriesFromFile(file);
		expect(entries.some((e) => e.type === "message")).toBe(true);
	});

	it("rejects ids that could escape the session dir via path traversal", () => {
		const dir = freshDir();
		expect(() => SessionManager.openOrCreateById("../escape", "/tmp/work", dir)).toThrow();
	});
});
