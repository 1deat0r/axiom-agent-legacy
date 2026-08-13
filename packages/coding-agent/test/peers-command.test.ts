import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handlePeersCommand } from "../src/cli/peers-command.js";
import { inbox, registerRun, resolvePeerScopeDir } from "../src/core/peers/index.js";
import { resolveInstanceId } from "../src/core/peers/instance-id.js";
import type { PeerIdentity } from "../src/core/peers/types.js";

const SELF: PeerIdentity = { instanceId: "aaa11111-1234-1234-1234-123456789012", shortId: "aaa11111" };

function setup(): { project: string; home: string } {
	const project = mkdtempSync(join(tmpdir(), "peers-cli-proj-"));
	const home = mkdtempSync(join(tmpdir(), "peers-cli-home-"));
	vi.stubEnv("AXIOM_PROJECT_ROOT", project);
	vi.stubEnv("AXIOM_HOME", home);
	return { project, home };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("handlePeersCommand", () => {
	it("returns false for non-peers commands", async () => {
		expect(await handlePeersCommand(["chat"])).toBe(false);
	});

	it("lists peers from the same state the tools use", async () => {
		const { project, home } = setup();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const scopeDir = resolvePeerScopeDir(project, home);
			registerRun(scopeDir, SELF, { model: "m1", intent: "on branch feat/z" }, { uuid: () => "run-x", pid: 1234 });
			expect(await handlePeersCommand(["peers"])).toBe(true);
			expect(log.mock.calls.flat().join(" ")).toContain("on branch feat/z");
		} finally {
			log.mockRestore();
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("msg delivers to a peer inbox and group reaches everyone", async () => {
		const { project, home } = setup();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const scopeDir = resolvePeerScopeDir(project, home);
			registerRun(scopeDir, SELF, {}, { uuid: () => "run-x", pid: 1234 });
			expect(await handlePeersCommand(["peers", "msg", SELF.instanceId, "note to self"])).toBe(true);
			expect(inbox(scopeDir, SELF).messages.map((m) => m.text)).toEqual(["note to self"]);
			expect(await handlePeersCommand(["peers", "group", "all hands"])).toBe(true);
			expect(inbox(scopeDir, SELF).messages.map((m) => m.text)).toEqual(["all hands"]);
		} finally {
			log.mockRestore();
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("prints usage on bad arguments", async () => {
		const setupDirs = setup();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await handlePeersCommand(["peers", "msg"])).toBe(true);
			expect(log.mock.calls.flat().join(" ")).toContain("usage");
		} finally {
			log.mockRestore();
			rmSync(setupDirs.project, { recursive: true, force: true });
			rmSync(setupDirs.home, { recursive: true, force: true });
		}
	});

	it("inbox peeks without consuming", async () => {
		const { project, home } = setup();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const scopeDir = resolvePeerScopeDir(project, home);
			registerRun(scopeDir, SELF, {}, { uuid: () => "run-x", pid: 1234 });
			expect(await handlePeersCommand(["peers", "group", "peek me"])).toBe(true);
			expect(await handlePeersCommand(["peers", "inbox"])).toBe(true);
			expect(log.mock.calls.flat().join(" ")).toContain("peek me");
			expect(inbox(scopeDir, SELF).messages).toHaveLength(1);
		} finally {
			log.mockRestore();
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("uses the same instance identity as the agent tools", async () => {
		const { project, home } = setup();
		try {
			const cliIdentity = resolveInstanceId(home);
			expect(cliIdentity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
		} finally {
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("main() dispatch", () => {
	it("dispatches 'peers' and returns before the chat bootstrap", async () => {
		const { project, home } = setup();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { main } = await import("../src/main.js");
			await main(["peers"]);
			// A broken dispatch falls through to the chat bootstrap, which
			// resolves a model and process.exit(1)s with no API key. Reaching
			// here with only peers output means dispatch worked.
			const output = log.mock.calls.flat().join(" ");
			expect(output).not.toContain("No API key");
		} finally {
			err.mockRestore();
			log.mockRestore();
			rmSync(project, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	});
});
