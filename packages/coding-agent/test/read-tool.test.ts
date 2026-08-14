import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

const readTool = createReadTool(process.cwd());

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

describe("read tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "read-tool-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("reads a whole file with line numbers", async () => {
		const file = join(testDir, "hello.txt");
		writeFileSync(file, "first line\nsecond line\nthird line\n");

		const result = await readTool.execute("call-1", { path: file });
		const text = getText(result);

		expect(text).toContain("hello.txt");
		expect(text).toContain("   1\tfirst line");
		expect(text).toContain("   2\tsecond line");
		expect(text).toContain("   3\tthird line");
		expect(result.details.totalLines).toBe(3);
		expect(result.details.truncated).toBe(false);
	});

	it("reads a 1-based line range", async () => {
		const file = join(testDir, "range.txt");
		writeFileSync(file, "a\nb\nc\nd\ne\n");

		const result = await readTool.execute("call-2", { path: file, startLine: 2, endLine: 4 });
		const text = getText(result);

		expect(text).toContain("   2\tb");
		expect(text).toContain("   4\td");
		expect(text).not.toContain("\ta");
		expect(text).not.toContain("\te");
		expect(result.details.startLine).toBe(2);
		expect(result.details.endLine).toBe(4);
	});

	it("clamps endLine to the last line", async () => {
		const file = join(testDir, "clamp.txt");
		writeFileSync(file, "one\ntwo\n");

		const result = await readTool.execute("call-3", { path: file, startLine: 1, endLine: 99 });
		expect(result.details.endLine).toBe(2);
	});

	it("rejects endLine before startLine", async () => {
		const file = join(testDir, "bad-range.txt");
		writeFileSync(file, "one\ntwo\n");

		await expect(readTool.execute("call-4", { path: file, startLine: 3, endLine: 1 })).rejects.toThrow(
			/endLine .* must be >= startLine/i,
		);
	});

	it("rejects non-positive line numbers", async () => {
		const file = join(testDir, "bad-line.txt");
		writeFileSync(file, "one\n");

		await expect(readTool.execute("call-5", { path: file, startLine: 0 })).rejects.toThrow(/positive/i);
	});

	it("errors when startLine exceeds the file length", async () => {
		const file = join(testDir, "past-end.txt");
		writeFileSync(file, "one\ntwo\n");

		await expect(readTool.execute("call-6", { path: file, startLine: 10 })).rejects.toThrow(/exceeds/i);
	});

	it("truncates long files and reports the totals", async () => {
		const file = join(testDir, "long.txt");
		const lines = Array.from({ length: 3000 }, (_, i) => `line number ${i}`).join("\n");
		writeFileSync(file, lines);

		const result = await readTool.execute("call-7", { path: file });
		const text = getText(result);

		expect(result.details.truncated).toBe(true);
		expect(result.details.totalLines).toBe(3000);
		expect(text).toContain("Truncated");
	});

	it("respects a larger maxBytes override", async () => {
		const file = join(testDir, "bytes.txt");
		const line = "x".repeat(1024);
		writeFileSync(file, Array.from({ length: 60 }, () => line).join("\n")); // ~60KB

		const small = await readTool.execute("call-8a", { path: file });
		expect(small.details.truncated).toBe(true);

		const large = await readTool.execute("call-8b", { path: file, maxBytes: 120 * 1024 });
		expect(large.details.truncated).toBe(false);
	});

	it("rejects files over the hard cap with guidance", async () => {
		const file = join(testDir, "huge.bin");
		writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1024, 0x61));

		await expect(readTool.execute("call-9", { path: file })).rejects.toThrow(/2\.0MB/i);
	});

	it("errors on a missing file", async () => {
		await expect(readTool.execute("call-10", { path: join(testDir, "nope.txt") })).rejects.toThrow(
			/Could not read file/i,
		);
	});

	it("errors on a directory path", async () => {
		await expect(readTool.execute("call-11", { path: testDir })).rejects.toThrow(/directory/i);
	});

	it("errors on binary content and never returns raw bytes", async () => {
		const file = join(testDir, "blob.bin");
		writeFileSync(file, Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64]));

		await expect(readTool.execute("call-12", { path: file })).rejects.toThrow(/binary/i);
	});

	it("never modifies the file it reads", async () => {
		const file = join(testDir, "untouched.txt");
		const content = "do not touch me\n";
		writeFileSync(file, content);

		await readTool.execute("call-13", { path: file });
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("handles an empty file", async () => {
		const file = join(testDir, "empty.txt");
		writeFileSync(file, "");

		const result = await readTool.execute("call-14", { path: file });
		expect(getText(result)).toContain("empty");
		expect(result.details.totalLines).toBe(0);
	});

	it("strips a BOM from the display and reports it", async () => {
		const file = join(testDir, "bom.txt");
		writeFileSync(file, "\uFEFFhello\nworld\n");

		const result = await readTool.execute("call-15", { path: file });
		const text = getText(result);

		expect(text).not.toContain("\uFEFF");
		expect(text).toContain("hello");
		expect(result.details.bomStripped).toBe(true);
	});

	it("drops carriage returns from CRLF files", async () => {
		const file = join(testDir, "crlf.txt");
		writeFileSync(file, "a\r\nb\r\n");

		const result = await readTool.execute("call-16", { path: file });
		const text = getText(result);

		expect(text).toContain("   1\ta");
		expect(text).toContain("   2\tb");
	});

	it("aborts before the read when the signal is already aborted", async () => {
		const file = join(testDir, "abort.txt");
		writeFileSync(file, "content\n");
		const controller = new AbortController();
		controller.abort();

		await expect(readTool.execute("call-17", { path: file }, controller.signal)).rejects.toThrow(
			/Operation aborted/i,
		);
	});
});

describe("read tool threat corpus (2026-08-15, issue #45)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "read-corpus-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// R1: a directory path must error, never leak a listing into the context.
	it("R1 directory paths return an error, not a listing", async () => {
		mkdirSync(join(testDir, "sub"));
		await expect(readTool.execute("r1", { path: join(testDir, "sub") })).rejects.toThrow(/directory/i);
	});

	// R2: a FIFO with no writer must not hang the turn; non-regular files error immediately.
	it("R2 FIFO paths error instead of hanging", async () => {
		const fifo = join(testDir, "pipe");
		execFileSync("mkfifo", [fifo]);
		await expect(readTool.execute("r2", { path: fifo })).rejects.toThrow(/regular file/i);
	});

	// R3: binary payloads never enter the model context as raw bytes.
	it("R3 binary content is rejected outright", async () => {
		const file = join(testDir, "exe.bin");
		writeFileSync(file, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
		await expect(readTool.execute("r3", { path: file })).rejects.toThrow(/binary/i);
	});

	// R4: a symlink inside the project reads its target (same trust model as edit/bash), and the read writes nothing.
	it("R4 symlinks resolve to the target and the tool writes nothing", async () => {
		const outside = mkdtempSync(join(tmpdir(), "outside-"));
		const target = join(outside, "target.txt");
		writeFileSync(target, "outside content\n");
		const link = join(testDir, "link.txt");
		symlinkSync(target, link);

		const result = await readTool.execute("r4", { path: link });
		expect(getText(result)).toContain("outside content");
		expect(readFileSync(target, "utf8")).toBe("outside content\n");
	});

	// R5: device nodes are not regular files and must error, never read.
	it("R5 device nodes error as non-regular files", async () => {
		await expect(readTool.execute("r5", { path: "/dev/null" })).rejects.toThrow(/regular file/i);
	});
});
