import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

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
});
