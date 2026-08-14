import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWriteTool } from "../src/core/tools/write.js";

const writeTool = createWriteTool(process.cwd());

function getText(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") ?? ""
	);
}

describe("write tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "write-tool-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("creates a new file with LF endings by default", async () => {
		const file = join(testDir, "new.txt");
		const result = await writeTool.execute("w-1", { path: file, content: "one\ntwo\n" });

		expect(getText(result)).toContain("Wrote");
		expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
		expect(result.details.created).toBe(true);
		expect(result.details.diff).toBeUndefined();
	});

	it("fails in create mode when the file exists", async () => {
		const file = join(testDir, "exists.txt");
		writeFileSync(file, "old\n");

		await expect(writeTool.execute("w-2", { path: file, content: "new\n" })).rejects.toThrow(/already exists/i);
		expect(readFileSync(file, "utf8")).toBe("old\n");
	});

	it("does not clobber a symlink target in create mode", async () => {
		const target = join(testDir, "target.txt");
		writeFileSync(target, "target body\n");
		const link = join(testDir, "link.txt");
		symlinkSync(target, link);

		await expect(writeTool.execute("w-3", { path: link, content: "attack\n" })).rejects.toThrow(/already exists/i);
		expect(readFileSync(target, "utf8")).toBe("target body\n");
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it("replaces an existing file in overwrite mode", async () => {
		const file = join(testDir, "over.txt");
		writeFileSync(file, "old line\n");

		const result = await writeTool.execute("w-4", { path: file, content: "new line\n", mode: "overwrite" });
		expect(readFileSync(file, "utf8")).toBe("new line\n");
		expect(result.details.created).toBe(false);
		expect(result.details.diff).toBeDefined();
	});

	it("creates a missing file in overwrite mode", async () => {
		const file = join(testDir, "missing.txt");
		const result = await writeTool.execute("w-5", { path: file, content: "born\n", mode: "overwrite" });

		expect(readFileSync(file, "utf8")).toBe("born\n");
		expect(result.details.created).toBe(true);
	});

	it("preserves CRLF endings on overwrite", async () => {
		const file = join(testDir, "crlf.txt");
		writeFileSync(file, "a\r\nb\r\n");

		await writeTool.execute("w-6", { path: file, content: "a\nc\n", mode: "overwrite" });
		expect(readFileSync(file, "utf8")).toBe("a\r\nc\r\n");
	});

	it("honors an explicit lineEndings override", async () => {
		const file = join(testDir, "forced.txt");
		writeFileSync(file, "a\n");

		await writeTool.execute("w-7", { path: file, content: "a\nb\n", mode: "overwrite", lineEndings: "crlf" });
		expect(readFileSync(file, "utf8")).toBe("a\r\nb\r\n");
	});

	it("preserves a BOM on overwrite and never adds one on create", async () => {
		const bomFile = join(testDir, "bom.txt");
		writeFileSync(bomFile, "\uFEFFhello\n");

		await writeTool.execute("w-8a", { path: bomFile, content: "world\n", mode: "overwrite" });
		expect(readFileSync(bomFile, "utf8")).toBe("\uFEFFworld\n");
		expect(writeTool).toBeDefined();

		const fresh = join(testDir, "fresh.txt");
		await writeTool.execute("w-8b", { path: fresh, content: "plain\n" });
		expect(readFileSync(fresh, "utf8")).toBe("plain\n");
	});

	it("returns a unified diff on overwrite", async () => {
		const file = join(testDir, "diff.txt");
		writeFileSync(file, "keep\nremove\n");

		const result = await writeTool.execute("w-9", { path: file, content: "keep\nadd\n", mode: "overwrite" });
		const text = getText(result);

		expect(result.details.diff).toBeDefined();
		expect(text).toContain("-2 remove");
		expect(text).toContain("+2 add");
	});

	it("errors when the parent directory is missing", async () => {
		await expect(
			writeTool.execute("w-10", { path: join(testDir, "no-dir", "x.txt"), content: "x\n" }),
		).rejects.toThrow(/parent directory/i);
	});

	it("preserves file permissions on overwrite", async () => {
		const file = join(testDir, "mode.txt");
		writeFileSync(file, "a\n");
		chmodSync(file, 0o640);

		await writeTool.execute("w-11", { path: file, content: "b\n", mode: "overwrite" });
		expect(statSync(file).mode & 0o777).toBe(0o640);
	});

	it("replaces a symlink instead of following it on overwrite", async () => {
		const target = join(testDir, "real.txt");
		writeFileSync(target, "real body\n");
		const link = join(testDir, "link.txt");
		symlinkSync(target, link);

		await writeTool.execute("w-12", { path: link, content: "new body\n", mode: "overwrite" });

		expect(readFileSync(target, "utf8")).toBe("real body\n");
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(readFileSync(link, "utf8")).toBe("new body\n");
	});

	it("leaves no temp files behind after overwrite", async () => {
		const file = join(testDir, "clean.txt");
		writeFileSync(file, "a\n");

		await writeTool.execute("w-13", { path: file, content: "b\n", mode: "overwrite" });

		const leftovers = readdirSync(testDir).filter((name) => name.includes(".axiom-tmp"));
		expect(leftovers).toEqual([]);
	});

	it("errors on a directory path", async () => {
		await expect(writeTool.execute("w-14", { path: testDir, content: "x\n", mode: "overwrite" })).rejects.toThrow(
			/directory/i,
		);
	});

	it("writes an empty file", async () => {
		const file = join(testDir, "empty.txt");
		const result = await writeTool.execute("w-15", { path: file, content: "" });

		expect(readFileSync(file, "utf8")).toBe("");
		expect(result.details.bytesWritten).toBe(0);
	});

	it("aborts before writing when the signal is already aborted", async () => {
		const file = join(testDir, "abort.txt");
		writeFileSync(file, "keep\n");
		const controller = new AbortController();
		controller.abort();

		await expect(
			writeTool.execute("w-16", { path: file, content: "gone\n", mode: "overwrite" }, controller.signal),
		).rejects.toThrow(/Operation aborted/i);
		expect(readFileSync(file, "utf8")).toBe("keep\n");
	});

	it("exactly one concurrent create wins the same path", async () => {
		const file = join(testDir, "race.txt");

		const results = await Promise.allSettled([
			writeTool.execute("w-17a", { path: file, content: "first\n" }),
			writeTool.execute("w-17b", { path: file, content: "second\n" }),
		]);

		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");
		expect(fulfilled.length).toBe(1);
		expect(rejected.length).toBe(1);
		expect(readFileSync(file, "utf8")).toMatch(/^(first|second)\n$/);
	});
});

describe("write path resolution (family consistency with read)", () => {
	it("overwrites the tolerant-resolved path for macOS variant filenames", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-write-path-"));
		try {
			// The file exists under the curly-quote name (macOS screenshot style);
			// the agent types the straight-quote path.
			const curly = join(dir, "Capture d’ecran.png");
			const straight = join(dir, "Capture d'ecran.png");
			await writeFile(curly, "old");
			const tool = createWriteTool(dir);
			const result = await tool.execute(
				"t1",
				{ path: straight, content: "new", mode: "overwrite" },
				undefined,
				() => {},
			);
			expect(result.details?.path).toBe(curly);
			expect(readFile(curly, "utf8")).resolves.toBe("new");
			expect(existsSync(straight)).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
