import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCompletionRunner, fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";

/** Write an executable axiom/signal shim that records argv to SHIM_ARGV and prints a canned line. */
async function writeShim(dir: string, binName: string, outText = "ok"): Promise<string> {
	const bin = join(dir, binName);
	await writeFile(
		bin,
		"#!/usr/bin/env node\n" +
			'import {writeFileSync} from "node:fs";\n' +
			"writeFileSync(process.env.SHIM_ARGV, JSON.stringify(process.argv.slice(2)));\n" +
			`process.stdout.write("${outText}\\n");\n`,
	);
	await chmod(bin, 0o755);
	return bin;
}

describe("sessionIdForChannel", () => {
	it("is deterministic and filesystem-safe", () => {
		expect(sessionIdForChannel("+1")).toBe(sessionIdForChannel("+1"));
		expect(sessionIdForChannel("+1").startsWith("gw-")).toBe(true);
	});
});

describe("fakeCompletionRunner", () => {
	it("records calls and returns a canned reply", async () => {
		const r = fakeCompletionRunner();
		const out = await r.runCompletion({ sessionId: "s", prompt: "hello", profile: { name: "p" } });
		expect(out.reply).toContain("hello");
		expect(r.calls).toHaveLength(1);
	});
});

describe("CliCompletionRunner", () => {
	it("invokes the axiom CLI in print mode under --profile --session-id and captures stdout", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-comp-"));
		try {
			const outDir = join(dir, "out");
			await mkdir(outDir, { recursive: true });
			const bin = await writeShim(dir, "axiom.mjs", "gateway: the SOUL.md ride lives here");
			process.env.SHIM_ARGV = join(outDir, "argv.json");
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			const out = await runner.runCompletion({ sessionId: "gw-abc", prompt: "hello", profile: { name: "builder" } });
			const argv = JSON.parse(await readFile(join(outDir, "argv.json"), "utf8")) as string[];
			expect(argv).toEqual(["-p", "hello", "--profile", "builder", "--session-id", "gw-abc"]);
			expect(out.reply).toBe("gateway: the SOUL.md ride lives here");
			expect(out.error).toBeUndefined();
		} finally {
			delete process.env.SHIM_ARGV;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("omits --profile for the implicit default profile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-comp-def-"));
		try {
			const outDir = join(dir, "out");
			await mkdir(outDir, { recursive: true });
			const bin = await writeShim(dir, "axiom.mjs");
			process.env.SHIM_ARGV = join(outDir, "argv.json");
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			await runner.runCompletion({ sessionId: "gw-def", prompt: "hi", profile: { name: "default" } });
			const argv = JSON.parse(await readFile(join(outDir, "argv.json"), "utf8")) as string[];
			expect(argv).toEqual(["-p", "hi", "--session-id", "gw-def"]);
		} finally {
			delete process.env.SHIM_ARGV;
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("CliCompletionRunner timeout", () => {
	it("surfaces an error and kills the child when a completion NEVER exits", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-comp-to-"));
		try {
			// A shim that prints nothing and never exits: the exact hang that
			// once wedged the per-channel queue with "could not run the agent".
			const bin = join(dir, "hang.mjs");
			await writeFile(
				bin,
				"#!/usr/bin/env node\n" +
					'import {writeFileSync} from "node:fs";\n' +
					"writeFileSync(process.env.SHIM_ARGV, 'hang');\n" +
					"setInterval(() => {}, 60_000);\n",
			);
			await chmod(bin, 0o755);
			process.env.SHIM_ARGV = join(dir, "argv.json");
			const runner = new CliCompletionRunner({ bin, printFlag: "-p", timeoutMs: 150 });
			const out = await runner.runCompletion({ sessionId: "gw-hang", prompt: "hi", profile: { name: "default" } });
			expect(out.reply).toBe("");
			expect(out.error).toMatch(/timed out after 150ms/);
		} finally {
			delete process.env.SHIM_ARGV;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
