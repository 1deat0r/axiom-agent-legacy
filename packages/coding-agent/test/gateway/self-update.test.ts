import { describe, expect, it } from "vitest";
import type { UpdateShell } from "../../src/gateway/self-update.js";
import { applyUpdate, checkUpdate, resolveUpdateConfig } from "../../src/gateway/self-update.js";

/** Scripted shell: each argv array maps to one canned result; calls recorded. */
function fakeShell(responses: Record<string, { code: number; stdout?: string; stderr?: string }>) {
	const calls: string[] = [];
	const shell: UpdateShell = {
		async run(cmd) {
			const key = cmd.join(" ");
			calls.push(key);
			const r = responses[key];
			if (!r) throw new Error(`no fake response for: ${key}`);
			return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
		},
	};
	return { shell, calls };
}

const CFG = { repoDir: "/repo" };

/** Default responses for a healthy behind-by-one repo. */
function healthyResponses(
	current = "aaa",
	latest = "bbb",
): Record<string, { code: number; stdout?: string; stderr?: string }> {
	return {
		"git -C /repo rev-parse --abbrev-ref HEAD": { code: 0, stdout: "main\n" },
		"git -C /repo status --porcelain": { code: 0, stdout: "" },
		"git -C /repo fetch origin": { code: 0 },
		"git -C /repo rev-parse HEAD": { code: 0, stdout: `${current}\n` },
		"git -C /repo rev-parse origin/main": { code: 0, stdout: `${latest}\n` },
		"git -C /repo merge --ff-only origin/main": { code: 0 },
		"npm run build": { code: 0 },
	};
}

describe("resolveUpdateConfig", () => {
	it("defaults branch main, buildCwd packages/coding-agent, build npm run build", () => {
		const r = resolveUpdateConfig(CFG);
		expect(r.branch).toBe("main");
		expect(r.buildCwd).toBe("/repo/packages/coding-agent");
		expect(r.buildCommand).toEqual(["npm", "run", "build"]);
	});
});

describe("checkUpdate", () => {
	it("reports up to date when HEAD equals origin/main", async () => {
		const { shell, calls } = fakeShell(healthyResponses("ccc", "ccc"));
		const r = await checkUpdate(shell, CFG);
		expect(r).toEqual({ ok: true, current: "ccc", latest: "ccc", upToDate: true });
		expect(calls).toContain("git -C /repo fetch origin");
	});

	it("reports behind when origin/main is ahead", async () => {
		const { shell } = fakeShell(healthyResponses());
		const r = await checkUpdate(shell, CFG);
		expect(r).toEqual({ ok: true, current: "aaa", latest: "bbb", upToDate: false });
	});

	it("refuses when the worktree is not on the configured branch", async () => {
		const responses = healthyResponses();
		responses["git -C /repo rev-parse --abbrev-ref HEAD"] = { code: 0, stdout: "feat/x\n" };
		const { shell } = fakeShell(responses);
		const r = await checkUpdate(shell, CFG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("main");
	});

	it("refuses when the worktree is dirty", async () => {
		const responses = healthyResponses();
		responses["git -C /repo status --porcelain"] = {
			code: 0,
			stdout: " M packages/coding-agent/src/gateway/gateway.ts\n",
		};
		const { shell } = fakeShell(responses);
		const r = await checkUpdate(shell, CFG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("uncommitted");
	});

	it("refuses when fetch fails", async () => {
		const responses = healthyResponses();
		responses["git -C /repo fetch origin"] = { code: 1, stderr: "network down" };
		const { shell } = fakeShell(responses);
		const r = await checkUpdate(shell, CFG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("fetch");
	});
});

describe("applyUpdate", () => {
	it("fast-forwards and builds, returning from/to", async () => {
		const { shell, calls } = fakeShell(healthyResponses());
		const r = await applyUpdate(shell, CFG);
		expect(r).toEqual({ ok: true, from: "aaa", to: "bbb" });
		expect(calls).toContain("git -C /repo merge --ff-only origin/main");
		expect(calls).toContain("npm run build");
	});

	it("refuses to merge when not fast-forwardable, and never builds", async () => {
		const responses = healthyResponses();
		responses["git -C /repo merge --ff-only origin/main"] = {
			code: 1,
			stderr: "fatal: Not possible to fast-forward, aborting.",
		};
		const { shell, calls } = fakeShell(responses);
		const r = await applyUpdate(shell, CFG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("fast-forward");
		expect(calls).not.toContain("npm run build");
	});

	it("refuses when the build fails", async () => {
		const responses = healthyResponses();
		responses["npm run build"] = { code: 2, stderr: "tsgo: error TS2304" };
		const { shell } = fakeShell(responses);
		const r = await applyUpdate(shell, CFG);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("build");
	});

	it("refuses when fetch fails", async () => {
		const responses = healthyResponses();
		responses["git -C /repo fetch origin"] = { code: 1, stderr: "network down" };
		const { shell } = fakeShell(responses);
		const r = await applyUpdate(shell, CFG);
		expect(r.ok).toBe(false);
	});
});
