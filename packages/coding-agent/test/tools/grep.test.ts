import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition, type GrepOperations, type GrepToolInput } from "../../src/core/tools/grep.js";

/** Fake ripgrep runner: matches the JSON-line contract of `rg --json`. */
function makeOps(handlers: {
	runRg?: (args: string[], signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;
	statPath?: (path: string) => Promise<{ isDirectory: boolean; mtimeMs?: number }>;
	readFileLines?: (path: string) => Promise<string[]>;
}): GrepOperations {
	return {
		runRg: handlers.runRg ?? (async () => ({ code: 1, stdout: "", stderr: "" })),
		statPath: handlers.statPath ?? (async () => ({ isDirectory: true })),
		readFileLines: handlers.readFileLines ?? (async () => []),
	};
}

const matchLine = (path: string, line: number, text: string): string =>
	JSON.stringify({ type: "match", data: { path: { text: path }, line_number: line, lines: { text } } });

async function execute(
	args: GrepToolInput,
	ops: GrepOperations,
	signal?: AbortSignal,
): Promise<{ text: string; details?: any }> {
	const tool = createGrepToolDefinition("/repo", {
		operations: ops,
		ensureRg: async () => "/fake/rg",
	});
	const result = await tool.execute("call-1", args, signal, undefined, fromAny<never, unknown>({}));
	const text = result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("");
	return { text, details: result.details };
}

describe("grep tool - files mode", () => {
	it("delegates mtime sorting to ripgrep --sortr and renders paths relative", async () => {
		const seenArgs: string[][] = [];
		const ops = makeOps({
			runRg: async (args) => {
				seenArgs.push(args);
				return {
					code: 0,
					stdout: ["/repo/src/new.ts", "/repo/src/mid.ts", "/repo/src/old.ts"].join("\n"),
					stderr: "",
				};
			},
		});
		const { text, details } = await execute({ pattern: "TODO", mode: "files" }, ops);
		expect(text).toBe("src/new.ts\nsrc/mid.ts\nsrc/old.ts");
		expect(details.matchLimitReached).toBeUndefined();
		expect(seenArgs).toContainEqual(["--files-with-matches", "--sortr=modified", "--", "TODO", "/repo"]);
	});

	it("caps the file list at the limit and reports the cap", async () => {
		const ops = makeOps({
			runRg: async () => ({ code: 0, stdout: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"].join("\n"), stderr: "" }),
			statPath: async () => ({ isDirectory: true, mtimeMs: 1000 }),
		});
		const { text, details } = await execute({ pattern: "x", mode: "files", limit: 2 }, ops);
		expect(text).toBe("a.ts\nb.ts");
		expect(details.matchLimitReached).toBe(2);
	});

	it("falls back to unsorted output when the installed ripgrep lacks --sortr", async () => {
		const calls: string[][] = [];
		const ops = makeOps({
			runRg: async (args) => {
				calls.push(args);
				if (args.includes("--sortr=modified")) {
					return { code: 2, stdout: "", stderr: "error: unexpected flag '--sortr'" };
				}
				return { code: 0, stdout: "/repo/b.ts", stderr: "" };
			},
			statPath: async () => ({ isDirectory: true, mtimeMs: 1000 }),
		});
		const { text, details } = await execute({ pattern: "x", mode: "files" }, ops);
		expect(text).toBe("b.ts");
		expect(details.sortFallback).toBe(true);
		expect(calls[1]).not.toContain("--sortr=modified");
	});
});

describe("grep tool - content mode", () => {
	it("returns relative path, line number, and text for each match", async () => {
		const ops = makeOps({
			runRg: async () => ({
				code: 0,
				stdout: [
					matchLine("/repo/src/a.ts", 7, "const x = 1;"),
					matchLine("/repo/src/a.ts", 9, "const y = 2;"),
				].join("\n"),
				stderr: "",
			}),
		});
		const { text } = await execute({ pattern: "const", mode: "content" }, ops);
		expect(text).toBe("src/a.ts:7: const x = 1;\nsrc/a.ts:9: const y = 2;");
	});

	it("renders context lines with a dash separator", async () => {
		const ops = makeOps({
			runRg: async () => ({
				code: 0,
				stdout: matchLine("/repo/src/a.ts", 2, "match"),
				stderr: "",
			}),
			readFileLines: async () => ["line one", "match", "line three"],
		});
		const { text } = await execute({ pattern: "match", mode: "content", context: 1 }, ops);
		expect(text).toBe("src/a.ts-1- line one\nsrc/a.ts:2: match\nsrc/a.ts-3- line three");
	});

	it("passes glob, ignore-case, literal, and context flags to ripgrep", async () => {
		const seenArgs: string[][] = [];
		const ops = makeOps({
			runRg: async (args) => {
				seenArgs.push(args);
				return { code: 1, stdout: "", stderr: "" };
			},
		});
		await execute({ pattern: "Foo", mode: "content", glob: "*.ts", ignoreCase: true, literal: true }, ops);
		expect(seenArgs[0]).toEqual(
			expect.arrayContaining([
				"--json",
				"--line-number",
				"--color=never",
				"--hidden",
				"--ignore-case",
				"--fixed-strings",
				"--glob",
				"*.ts",
			]),
		);
	});

	it("truncates long lines and reports it", async () => {
		const longLine = "x".repeat(600);
		const ops = makeOps({
			runRg: async () => ({
				code: 0,
				stdout: matchLine("/repo/src/a.ts", 1, longLine),
				stderr: "",
			}),
		});
		const { text, details } = await execute({ pattern: "x", mode: "content" }, ops);
		expect(text.length).toBeLessThan(longLine.length + 20);
		expect(details.linesTruncated).toBe(true);
	});

	it("caps matches at the limit and reports the cap", async () => {
		const ops = makeOps({
			runRg: async () => ({
				code: 0,
				stdout: [
					matchLine("/repo/a.ts", 1, "x"),
					matchLine("/repo/a.ts", 2, "x"),
					matchLine("/repo/a.ts", 3, "x"),
				].join("\n"),
				stderr: "",
			}),
		});
		const { text, details } = await execute({ pattern: "x", mode: "content", limit: 2 }, ops);
		expect(text).toBe("a.ts:1: x\na.ts:2: x");
		expect(details.matchLimitReached).toBe(2);
	});

	it("returns 'No matches found' on ripgrep exit code 1", async () => {
		const ops = makeOps({ runRg: async () => ({ code: 1, stdout: "", stderr: "" }) });
		const { text } = await execute({ pattern: "zzz", mode: "content" }, ops);
		expect(text).toBe("No matches found");
	});
});

describe("grep tool - errors and edges", () => {
	it("rejects with a clear message when ripgrep is unavailable", async () => {
		const tool = createGrepToolDefinition("/repo", {
			operations: makeOps({}),
			ensureRg: async () => undefined,
		});
		await expect(
			tool.execute("call-1", { pattern: "x" }, undefined, undefined, fromAny<never, unknown>({})),
		).rejects.toThrow(/ripgrep \(rg\) is not available/);
	});

	it("rejects when the search path does not exist", async () => {
		const ops = makeOps({ statPath: async () => Promise.reject(new Error("ENOENT")) });
		await expect(execute({ pattern: "x", path: "missing" }, ops)).rejects.toThrow(/Path not found/);
	});

	it("rejects with the ripgrep stderr on exit code 2", async () => {
		const ops = makeOps({
			runRg: async () => ({ code: 2, stdout: "", stderr: "bad regex" }),
		});
		await expect(execute({ pattern: "([", mode: "content" }, ops)).rejects.toThrow(/bad regex/);
	});

	it("surfaces the output-cap message when ripgrep is killed without an abort", async () => {
		const ops = makeOps({
			runRg: async () => ({ code: null, stdout: "", stderr: "ripgrep output exceeded the cap; narrow the search" }),
		});
		await expect(execute({ pattern: "x", mode: "content" }, ops)).rejects.toThrow(/narrow the search/);
	});

	it("rejects when the abort signal fires", async () => {
		const controller = new AbortController();
		const ops = makeOps({
			runRg: async () => {
				controller.abort();
				return { code: null, stdout: "", stderr: "" };
			},
		});
		await expect(execute({ pattern: "x" }, ops, controller.signal)).rejects.toThrow(/aborted/i);
	});

	it("exposes a tight tool definition with both modes documented", () => {
		const def = createGrepToolDefinition("/repo");
		expect(def.name).toBe("grep");
		expect(def.description).toMatch(/files mode/i);
		expect(def.description).toMatch(/content mode/i);
		expect(def.promptSnippet).toMatch(/search/i);
	});
});

describe("grep tool - live ripgrep (skipped when rg is absent)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "grep-live-"));
		spawnSync("git", ["init", "-q"], { cwd: dir });
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "new.ts"), "export const answer = 42;\n");
		writeFileSync(join(dir, "src", "old.ts"), "// answer lives here too\n");
		writeFileSync(join(dir, "ignored.txt"), "answer\n");
		writeFileSync(join(dir, ".gitignore"), "*.txt\n");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("finds files and content and respects .gitignore", async () => {
		const probe = spawnSync("rg", ["--version"], { encoding: "utf8" });
		if (probe.error || probe.status !== 0) return; // rg absent: skip live assertions
		const tool = createGrepToolDefinition(dir);
		const files = await tool.execute(
			"call-1",
			{ pattern: "answer", mode: "files" },
			undefined,
			undefined,
			fromAny<never, unknown>({}),
		);
		const filesText = files.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");
		expect(filesText).toContain("old.ts");
		expect(filesText).toContain("new.ts");
		expect(filesText).not.toContain("ignored.txt");

		const content = await tool.execute(
			"call-1",
			{ pattern: "answer", mode: "content" },
			undefined,
			undefined,
			fromAny<never, unknown>({}),
		);
		const contentText = content.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");
		expect(contentText).toMatch(/new\.ts:1: export const answer/);
	});
});
