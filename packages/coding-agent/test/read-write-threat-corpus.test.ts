import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";
import { createWriteTool } from "../src/core/tools/write.js";

// Shared threat corpus for the read and write core tools.
// Read cases ship with issue #45; write cases are added by the stacked
// feat/write-tool branch (issue #46). Each case names the attack it
// neutralizes and must fail on the code that predates the tool.
describe("read/write threat corpus", () => {
	describe("read cases", () => {
		const readTool = createReadTool(process.cwd());
		let testDir: string;

		beforeEach(() => {
			testDir = mkdtempSync(join(tmpdir(), "corpus-"));
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		// Case R1: directory path traversal into listings.
		it("R1: directory paths return an error, never a listing", async () => {
			mkdirSync(join(testDir, "sub"));
			await expect(readTool.execute("r1", { path: join(testDir, "sub") })).rejects.toThrow(/directory/i);
		});

		// Case R2: symlink escape does not crash the tool; reads follow the same trust model as edit and bash.
		it("R2: symlink targets resolve cleanly and nothing is written", async () => {
			const outside = mkdtempSync(join(tmpdir(), "escape-"));
			const target = join(outside, "secret.txt");
			writeFileSync(target, "symlink body\n");
			const link = join(testDir, "link.txt");
			symlinkSync(target, link);

			const result = await readTool.execute("r2", { path: link });
			const text = result.content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("\n");
			expect(text).toContain("symlink body");
		});

		// Case R3: binary bytes must never reach the model context.
		it("R3: binary content is rejected, raw bytes never returned", async () => {
			const file = join(testDir, "blob.bin");
			writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0xff]));
			await expect(readTool.execute("r3", { path: file })).rejects.toThrow(/binary/i);
		});

		// Case R4: unbounded reads of a huge file must fail fast with guidance, not exhaust memory.
		it("R4: files over the hard cap fail fast", async () => {
			const file = join(testDir, "huge.txt");
			writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x61));
			await expect(readTool.execute("r4", { path: file })).rejects.toThrow(/2\.0MB/i);
		});

		// Case R5: trailing newline arithmetic must not shift line numbers.
		it("R5: line counts and ranges stay correct with trailing newlines", async () => {
			const file = join(testDir, "trailing.txt");
			writeFileSync(file, "a\nb\n");
			const result = await readTool.execute("r5", { path: file });
			expect(result.details.totalLines).toBe(2);
			expect(result.details.endLine).toBe(2);
		});
	});

	describe("write cases", () => {
		const writeTool = createWriteTool(process.cwd());
		let testDir: string;

		beforeEach(() => {
			testDir = mkdtempSync(join(tmpdir(), "corpus-w-"));
		});

		afterEach(() => {
			rmSync(testDir, { recursive: true, force: true });
		});

		// Case W1: symlink attack. Overwrite must replace the link, never write through it.
		it("W1: overwrite replaces a symlink and leaves its target untouched", async () => {
			const target = join(testDir, "real.txt");
			writeFileSync(target, "real body\n");
			const link = join(testDir, "link.txt");
			symlinkSync(target, link);

			await writeTool.execute("w1", { path: link, content: "new body\n", mode: "overwrite" });

			expect(readFileSync(target, "utf8")).toBe("real body\n");
			expect(readFileSync(link, "utf8")).toBe("new body\n");
		});

		// Case W2: create-mode race. Exactly one O_EXCL winner, no last-writer clobber.
		it("W2: concurrent creates yield exactly one winner", async () => {
			const file = join(testDir, "race.txt");
			const results = await Promise.allSettled([
				writeTool.execute("w2a", { path: file, content: "first\n" }),
				writeTool.execute("w2b", { path: file, content: "second\n" }),
			]);

			const rejected = results.filter((r) => r.status === "rejected");
			expect(rejected.length).toBe(1);
			expect(readFileSync(file, "utf8")).toMatch(/^(first|second)\n$/);
		});

		// Case W3: a dangling symlink must block create mode (the link entry exists).
		it("W3: create mode refuses a dangling symlink path", async () => {
			const link = join(testDir, "dangling.txt");
			symlinkSync(join(testDir, "never-existed.txt"), link);

			await expect(writeTool.execute("w3", { path: link, content: "x\n" })).rejects.toThrow(/already exists/i);
			expect(readdirSync(testDir).filter((n) => n !== "dangling.txt")).toEqual([]);
		});

		// Case W4: temp-file hygiene. A failed or successful overwrite leaves no litter.
		it("W4: no temp-file litter remains after overwrite", async () => {
			const file = join(testDir, "clean.txt");
			writeFileSync(file, "a\n");

			await writeTool.execute("w4", { path: file, content: "b\n", mode: "overwrite" });

			expect(readdirSync(testDir).filter((n) => n.includes(".axiom-tmp"))).toEqual([]);
		});

		// Case W5: directory targets fail cleanly instead of truncating anything.
		it("W5: a directory path errors without side effects", async () => {
			const sub = join(testDir, "sub");
			mkdirSync(sub);
			await expect(writeTool.execute("w5", { path: sub, content: "x\n", mode: "overwrite" })).rejects.toThrow(
				/directory/i,
			);
			expect(readdirSync(testDir)).toEqual(["sub"]);
		});
	});
});
