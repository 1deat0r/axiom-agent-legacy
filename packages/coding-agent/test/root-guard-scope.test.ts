import { describe, expect, it } from "vitest";
import { checkPathScope } from "../src/core/root-guard/scope.js";

const ROOT = "/work/project";
const HOME = "/home/alice";

function block(result: unknown): { block: true; reason: string; paths: string[] } {
	expect(result).toBeDefined();
	return result as { block: true; reason: string; paths: string[] };
}

describe("checkPathScope (pure containment)", () => {
	it("allows paths lexically inside the root, including the root itself", () => {
		expect(
			checkPathScope({ paths: ["/work/project/src/a.ts", "docs/x.md"], root: ROOT, cwd: ROOT, home: HOME }),
		).toBeUndefined();
		expect(checkPathScope({ paths: ["."], root: ROOT, cwd: ROOT, home: HOME })).toBeUndefined();
	});

	it("allows dotted escapes that still resolve inside the root", () => {
		expect(checkPathScope({ paths: ["src/../tests/t.ts"], root: ROOT, cwd: ROOT, home: HOME })).toBeUndefined();
	});

	it("blocks absolute paths outside the root, naming the paths and the escape", () => {
		const d = block(checkPathScope({ paths: ["/etc/passwd"], root: ROOT, cwd: ROOT, home: HOME }));
		expect(d.paths).toEqual(["/etc/passwd"]);
		expect(d.reason).toContain("/etc/passwd");
		expect(d.reason).toMatch(/request_root_access/);
		expect(d.reason).toContain(ROOT);
	});

	it("blocks relative escapes that leave the root", () => {
		const d = block(checkPathScope({ paths: ["../../other"], root: ROOT, cwd: ROOT, home: HOME }));
		expect(d.paths).toEqual(["/other"]);
	});

	it("blocks tilde paths that resolve into home data", () => {
		const d = block(checkPathScope({ paths: ["~/notes.txt"], root: ROOT, cwd: ROOT, home: HOME }));
		expect(d.paths).toEqual(["/home/alice/notes.txt"]);
	});

	it("reports only the outside paths when a mix is present", () => {
		const d = block(checkPathScope({ paths: ["src/a.ts", "/etc/x"], root: ROOT, cwd: ROOT, home: HOME }));
		expect(d.paths).toEqual(["/etc/x"]);
	});

	it("allows outside paths that match an allow prefix", () => {
		expect(
			checkPathScope({
				paths: ["/tmp/scratch/x"],
				root: ROOT,
				cwd: ROOT,
				home: HOME,
				allowPrefixes: ["/tmp"],
			}),
		).toBeUndefined();
	});

	it("lets a deny prefix win over an allow prefix", () => {
		const d = block(
			checkPathScope({
				paths: ["/etc/passwd"],
				root: ROOT,
				cwd: ROOT,
				home: HOME,
				allowPrefixes: ["/etc"],
				denyPrefixes: ["/etc"],
			}),
		);
		expect(d.reason).toMatch(/denied/i);
	});

	it("applies a deny prefix even to paths inside the root", () => {
		const d = block(
			checkPathScope({
				paths: ["/work/project/.secrets/x"],
				root: ROOT,
				cwd: ROOT,
				home: HOME,
				denyPrefixes: ["/work/project/.secrets"],
			}),
		);
		expect(d.paths).toEqual(["/work/project/.secrets/x"]);
	});

	it("treats an unknown tilde-user as /home/<user>", () => {
		const d = block(checkPathScope({ paths: ["~bob/file"], root: ROOT, cwd: ROOT, home: HOME }));
		expect(d.paths).toEqual(["/home/bob/file"]);
	});

	it("does not block URLs (no path tokens reach it)", () => {
		expect(checkPathScope({ paths: ["x.dev/a/b"], root: ROOT, cwd: ROOT, home: HOME })).toBeUndefined();
	});
});

describe("checkPathScope shell shorthands and mixed reasons", () => {
	it("expands ~+ to the working directory (stays inside the root)", () => {
		expect(checkPathScope({ paths: ["~+"], root: ROOT, cwd: ROOT, home: HOME })).toBeUndefined();
	});

	it("leaves ~- unresolved so it resolves inside the root (best-effort)", () => {
		expect(checkPathScope({ paths: ["~-"], root: ROOT, cwd: ROOT, home: HOME })).toBeUndefined();
	});

	it("names denied and outside paths separately in a mixed block", () => {
		const d = block(
			checkPathScope({
				paths: ["/etc/passwd", "/mnt/x"],
				root: ROOT,
				cwd: ROOT,
				home: HOME,
				denyPrefixes: ["/etc"],
			}),
		);
		expect(d.reason).toMatch(/denied: \/etc\/passwd/);
		expect(d.reason).toMatch(/outside this project's root .*: \/mnt\/x/);
		expect(d.reason).toMatch(/request_root_access/);
	});
});
