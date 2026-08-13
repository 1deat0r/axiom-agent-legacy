import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDefaultCliPath } from "../src/modes/rpc/rpc-client.js";

describe("resolveDefaultCliPath", () => {
	const scratchDirs: string[] = [];

	const makeFixture = (layout: "legacy" | "monorepo" | "empty"): string => {
		const root = mkdtempSync(join(tmpdir(), "rpc-cli-path-"));
		scratchDirs.push(root);
		if (layout === "legacy") {
			mkdirSync(join(root, "dist"));
			writeFileSync(join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
		} else if (layout === "monorepo") {
			mkdirSync(join(root, "packages", "coding-agent", "dist"), { recursive: true });
			writeFileSync(join(root, "packages", "coding-agent", "dist", "cli.js"), "#!/usr/bin/env node\n");
		}
		return root;
	};

	afterEach(() => {
		for (const dir of scratchDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		scratchDirs.length = 0;
	});

	test("resolves the legacy repo-root dist layout when it exists", () => {
		const root = makeFixture("legacy");
		expect(resolveDefaultCliPath(root)).toBe(join(root, "dist", "cli.js"));
	});

	test("resolves the monorepo packages/coding-agent dist layout from the repo root", () => {
		const root = makeFixture("monorepo");
		expect(resolveDefaultCliPath(root)).toBe(join(root, "packages", "coding-agent", "dist", "cli.js"));
	});

	test("prefers the legacy layout when both exist", () => {
		const root = makeFixture("legacy");
		mkdirSync(join(root, "packages", "coding-agent", "dist"), { recursive: true });
		writeFileSync(join(root, "packages", "coding-agent", "dist", "cli.js"), "#!/usr/bin/env node\n");
		expect(resolveDefaultCliPath(root)).toBe(join(root, "dist", "cli.js"));
	});

	test("falls back to the legacy default when no candidate exists", () => {
		const root = makeFixture("empty");
		expect(resolveDefaultCliPath(root)).toBe(join(root, "dist", "cli.js"));
	});
});
