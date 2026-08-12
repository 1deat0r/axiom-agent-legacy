import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliCompletionRunner, fakeCompletionRunner, sessionIdForChannel } from "../../src/gateway/completion.js";

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
			const bin = join(dir, "axiom.mjs");
			// A tiny axiom shim that records args and echoes a canned final reply.
			await writeFile(
				bin,
				"#!/usr/bin/env node\n" +
					'import {writeFileSync} from "node:fs";\n' +
					`writeFileSync(process.env.SHIM_ARGV, JSON.stringify(process.argv.slice(2)));\n` +
					'process.stdout.write("gateway: the SOUL.md ride lives here\\n");\n',
			);
			process.env.SHIM_ARGV = join(outDir, "argv.json");
			await chmod(bin, 0o755);
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			const out = await runner.runCompletion({ sessionId: "gw-abc", prompt: "hello", profile: { name: "builder" } });
			const argv = JSON.parse(await readFile(join(outDir, "argv.json"), "utf8")) as string[];
			// The CLI is invoked exactly as main()'s print mode expects, under the profile.
			expect(argv).toEqual(["-p", "hello", "--profile", "builder", "--session-id", "gw-abc"]);
			expect(out.reply).toBe("gateway: the SOUL.md ride lives here");
			expect(out.error).toBeUndefined();
		} finally {
			delete process.env.SHIM_ARGV;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
