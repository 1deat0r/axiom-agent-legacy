import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bwrapCreatesNamespace } from "../../src/extensions/workspace/sandbox.js";
import {
	CliCompletionRunner,
	fakeCompletionRunner,
	resolveCompletionChild,
	sessionIdForChannel,
} from "../../src/gateway/completion.js";

// The real-bwrap anchored-confine test needs a working namespace (GitHub-hosted
// CI ships bwrap but forbids unprivileged user namespaces). Skip with reason there.
const bwrapUsable = bwrapCreatesNamespace();

/** Write an executable shim at an absolute path that records argv/meta and prints a canned line. */
async function writeShimAt(bin: string, outText = "ok"): Promise<string> {
	await writeFile(
		bin,
		"#!/usr/bin/env node\n" +
			'import {writeFileSync} from "node:fs";\n' +
			"writeFileSync(process.env.SHIM_ARGV, JSON.stringify(process.argv.slice(2)));\n" +
			"if (process.env.SHIM_META) writeFileSync(process.env.SHIM_META, JSON.stringify({ cwd: process.cwd(), root: process.env.AXIOM_PROJECT_ROOT ?? null, confined: process.env.AXIOM_CONFINED ?? null }));\n" +
			`process.stdout.write("${outText}\\n");\n`,
	);
	await chmod(bin, 0o755);
	return bin;
}

/** Write an executable shim in a dir (join the name for callers). */
async function writeShim(dir: string, binName: string, outText = "ok"): Promise<string> {
	return writeShimAt(join(dir, binName), outText);
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

describe("resolveCompletionChild (live-path guard: the child must be axiom-agent's own CLI)", () => {
	it("never falls back to the bare global 'axiom' command", () => {
		// Root-cause regressions: an unset AXIOM_BIN used to resolve to "axiom"
		// (the stale global pi-monorepo binary), which silently produced no reply.
		const child = resolveCompletionChild();
		expect(child.bin).not.toBe("axiom");
		// It must point at an axiom-agent entry: this package's built bundle, or
		// source-via-tsx when not built.
		const isOwnCli = child.bin.endsWith("/dist/bundle/cli.js") || child.bin === process.execPath;
		expect(isOwnCli).toBe(true);
		if (child.bin === process.execPath) {
			expect(child.prefix.join(" ")).toContain("src/cli.ts");
		} else {
			expect(child.prefix).toEqual([]);
		}
	});

	it("honors an explicit bin override", () => {
		const child = resolveCompletionChild("/tmp/shim.js");
		expect(child.bin).toBe("/tmp/shim.js");
		expect(child.prefix).toEqual([]);
	});

	it("honors AXIOM_BIN as the operator override", () => {
		const prev = process.env.AXIOM_BIN;
		process.env.AXIOM_BIN = "/opt/my-axiom/cli.js";
		try {
			const child = resolveCompletionChild();
			expect(child.bin).toBe("/opt/my-axiom/cli.js");
			expect(child.prefix).toEqual([]);
		} finally {
			if (prev === undefined) delete process.env.AXIOM_BIN;
			else process.env.AXIOM_BIN = prev;
		}
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

	it.skipIf(!bwrapUsable)(
		"anchors cwd + AXIOM_PROJECT_ROOT and OS-confines the child (bwrap) when anchored",
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "axiom-gw-proj-"));
			try {
				const projectRoot = join(dir, "project");
				await mkdir(projectRoot, { recursive: true });
				// shim + outputs live INSIDE the project root so they persist through
				// the sandbox (host /tmp is shadowed).
				const bin = join(projectRoot, "axiom.mjs");
				await writeShimAt(bin, "ok");
				const out = join(projectRoot, "out");
				await mkdir(out, { recursive: true });
				process.env.SHIM_ARGV = join(out, "argv.json");
				process.env.SHIM_META = join(out, "meta.json");
				const runner = new CliCompletionRunner({ bin, printFlag: "-p", projectRoot });
				const result = await runner.runCompletion({
					sessionId: "gw-p",
					prompt: "hi",
					profile: { name: "default" },
				});
				expect(result.error).toBeUndefined();
				const meta = JSON.parse(await readFile(join(out, "meta.json"), "utf8")) as {
					cwd: string;
					root: string | null;
					confined: string | null;
				};
				expect(meta.cwd).toBe(projectRoot);
				expect(meta.root).toBe(projectRoot);
				expect(meta.confined).toBe("1");
				expect(result.reply).toContain("[sandbox-confined]");
			} finally {
				delete process.env.SHIM_ARGV;
				delete process.env.SHIM_META;
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	it("fails CLOSED when an anchored run has no bubblewrap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-npb-"));
		const prevPath = process.env.PATH;
		try {
			const projectRoot = join(dir, "project");
			await mkdir(projectRoot, { recursive: true });
			const bin = join(projectRoot, "shim.mjs");
			await writeShimAt(bin, "ok");
			// Empty PATH -> resolveBwrap finds no bwrap -> the anchored run must
			// refuse to spawn unconfined (fail closed), never fall through.
			process.env.PATH = "";
			const runner = new CliCompletionRunner({ bin, printFlag: "-p", projectRoot });
			const out = await runner.runCompletion({ sessionId: "gw-f", prompt: "hi", profile: { name: "default" } });
			expect(out.reply).toBe("");
			expect(out.error).toMatch(/bubblewrap/i);
			expect(out.error).toMatch(/unconfined/i);
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("passes --profile default so the spawned agent reads the profile's provider settings", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-comp-def-"));
		try {
			const outDir = join(dir, "out");
			await mkdir(outDir, { recursive: true });
			const bin = await writeShim(dir, "axiom.mjs");
			process.env.SHIM_ARGV = join(outDir, "argv.json");
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			await runner.runCompletion({ sessionId: "gw-def", prompt: "hi", profile: { name: "default" } });
			const argv = JSON.parse(await readFile(join(outDir, "argv.json"), "utf8")) as string[];
			expect(argv).toEqual(["-p", "hi", "--profile", "default", "--session-id", "gw-def"]);
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

describe("CliCompletionRunner per-call projectRoot override", () => {
	it.skipIf(!bwrapUsable)("per-call projectRoot overrides an unset constructor root and anchors the run", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-ovr-"));
		try {
			const projectRoot = join(dir, "project");
			await mkdir(projectRoot, { recursive: true });
			const bin = join(projectRoot, "axiom.mjs");
			await writeShimAt(bin, "ok");
			const out = join(projectRoot, "out");
			await mkdir(out, { recursive: true });
			process.env.SHIM_ARGV = join(out, "argv.json");
			process.env.SHIM_META = join(out, "meta.json");
			// NO constructor projectRoot: the per-call input carries it.
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			const result = await runner.runCompletion({
				sessionId: "gw-o",
				prompt: "hi",
				profile: { name: "default" },
				projectRoot,
			});
			expect(result.error).toBeUndefined();
			const meta = JSON.parse(await readFile(join(out, "meta.json"), "utf8")) as {
				cwd: string;
				root: string | null;
				confined: string | null;
			};
			expect(meta.cwd).toBe(projectRoot);
			expect(meta.root).toBe(projectRoot);
			expect(meta.confined).toBe("1");
			expect(result.reply).toContain("[sandbox-confined]");
		} finally {
			delete process.env.SHIM_ARGV;
			delete process.env.SHIM_META;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("fails CLOSED when a per-call projectRoot anchors a run with no bubblewrap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-npo-"));
		const prevPath = process.env.PATH;
		try {
			const projectRoot = join(dir, "project");
			await mkdir(projectRoot, { recursive: true });
			const bin = join(projectRoot, "shim.mjs");
			await writeShimAt(bin, "ok");
			process.env.PATH = "";
			const runner = new CliCompletionRunner({ bin, printFlag: "-p" });
			const out = await runner.runCompletion({
				sessionId: "gw-o",
				prompt: "hi",
				profile: { name: "default" },
				projectRoot,
			});
			expect(out.reply).toBe("");
			expect(out.error).toMatch(/bubblewrap/i);
			expect(out.error).toMatch(/unconfined/i);
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			await rm(dir, { recursive: true, force: true });
		}
	});
});
