import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildWorkspaceRelaunchEnv,
	relaunchWorkspace,
	type WorkspaceRelaunchDeps,
	type WorkspaceRelaunchResult,
} from "../src/modes/interactive/components/workspace-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

function makeDeps() {
	const spawnSync = vi.fn<
		(
			command: string,
			args: readonly string[],
			options: { stdio: "inherit"; env: NodeJS.ProcessEnv },
		) => WorkspaceRelaunchResult
	>(() => ({ status: 7, signal: null, error: undefined }));
	// The exit dep is `never`-returning in production; a mock that returns
	// would let the relaunch fall through to a second exit call.
	const exit = vi.fn((code: number): never => {
		throw new Error(`process.exit(${code})`);
	});
	const deps: WorkspaceRelaunchDeps = { spawnSync, exit };
	return { spawnSync, exit, deps };
}

describe("relaunchWorkspace", () => {
	it("spawns the relaunch child with a BLOCKING spawn and mirrors its exit status", () => {
		const { spawnSync, exit, deps } = makeDeps();
		expect(() =>
			relaunchWorkspace(["node", "/tmp/cli.js"], { relaunchArgs: ["--profile", "alpha"], env: { FOO: "1" } }, deps),
		).toThrow("process.exit(7)");
		expect(spawnSync).toHaveBeenCalledTimes(1);
		expect(spawnSync).toHaveBeenCalledWith(
			process.execPath,
			[...process.execArgv, "/tmp/cli.js", "--profile", "alpha"],
			{ stdio: "inherit", env: { FOO: "1" } },
		);
		// The parent must NOT exit until the blocking spawn returns (the
		// relaunch child holds the terminal's foreground process group).
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(7);
	});

	it("maps a signal-terminated child to exit code 1", () => {
		const { spawnSync, exit, deps } = makeDeps();
		spawnSync.mockReturnValue({ status: null, signal: "SIGTERM", error: undefined });
		expect(() => relaunchWorkspace(["node", "/tmp/cli.js"], { relaunchArgs: [], env: {} }, deps)).toThrow(
			"process.exit(1)",
		);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("exits 1 and reports when the spawn itself fails", () => {
		const { spawnSync, exit, deps } = makeDeps();
		spawnSync.mockReturnValue({ status: null, signal: null, error: new Error("ENOENT") });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(() => relaunchWorkspace(["node", "/tmp/cli.js"], { relaunchArgs: [], env: {} }, deps)).toThrow(
				"process.exit(1)",
			);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to relaunch"));
			expect(exit).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("exits 1 when the CLI entrypoint cannot be determined", () => {
		const { spawnSync, exit, deps } = makeDeps();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			expect(() => relaunchWorkspace(["node"], { relaunchArgs: [], env: {} }, deps)).toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("entrypoint"));
			expect(exit).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
		expect(spawnSync).not.toHaveBeenCalled();
	});
});

describe("buildWorkspaceRelaunchEnv", () => {
	it("keeps the parent environment untouched for a project switch", () => {
		const env = { AXIOM_HOME: "/tmp/custom-home", K: "v" };
		expect(buildWorkspaceRelaunchEnv(env, { project: "acme" }, "/tmp/custom-home")).toBe(env);
	});

	it("pins AXIOM_HOME to the profile base home for a profile switch", () => {
		const nested = buildWorkspaceRelaunchEnv(
			{ AXIOM_HOME: "/tmp/h/profiles/foo", K: "v" },
			{ profile: "alpha" },
			"/tmp/h/profiles/foo",
		);
		expect(nested).toEqual({ AXIOM_HOME: "/tmp/h", K: "v" });

		const custom = buildWorkspaceRelaunchEnv({ AXIOM_HOME: "/custom", K: "v" }, { profile: "alpha" }, "/custom");
		expect(custom).toEqual({ AXIOM_HOME: "/custom", K: "v" });
	});

	it("derives the base home from the active home when AXIOM_HOME is unset", () => {
		const defaultHome = join(homedir(), ".axiom");
		const env = buildWorkspaceRelaunchEnv({ K: "v" }, { profile: "alpha" }, defaultHome);
		expect(env).toEqual({ K: "v", AXIOM_HOME: defaultHome });
	});
});

type SwitchWorkspaceThis = {
	stop(): void;
	agentConnection: { dispose(): Promise<unknown> };
	options: { onShutdown?(): Promise<unknown> };
	ui: { terminal: { drainInput(ms: number): Promise<unknown> } };
};

const prototype = InteractiveMode.prototype as unknown as {
	switchWorkspace(
		this: SwitchWorkspaceThis,
		opts: { profile?: string; project?: string },
		deps?: WorkspaceRelaunchDeps,
	): Promise<void>;
};

describe("InteractiveMode.switchWorkspace wiring", () => {
	const originalArgv = process.argv;

	function makeThis() {
		return {
			stop: vi.fn(),
			agentConnection: { dispose: vi.fn().mockResolvedValue(undefined) },
			options: { onShutdown: vi.fn().mockResolvedValue(undefined) },
			ui: { terminal: { drainInput: vi.fn().mockResolvedValue(undefined) } },
		};
	}

	afterEach(() => {
		process.argv = originalArgv;
		vi.unstubAllEnvs();
	});

	it("drains input, tears down, then relaunches through the injected BLOCKING spawn for a profile switch", async () => {
		const { spawnSync, exit, deps } = makeDeps();
		const fakeThis = makeThis();
		vi.stubEnv("AXIOM_HOME", "/tmp/probe-home");
		process.argv = ["node", "/tmp/cli.js", "--transport", "telegram", "--profile", "old", "--resume", "sess-1"];

		await expect(prototype.switchWorkspace.call(fakeThis, { profile: "alpha" }, deps)).rejects.toThrow(
			"process.exit(7)",
		);

		expect(fakeThis.ui.terminal.drainInput).toHaveBeenCalled();
		expect(fakeThis.stop).toHaveBeenCalled();
		expect(fakeThis.agentConnection.dispose).toHaveBeenCalled();
		expect(fakeThis.options.onShutdown).toHaveBeenCalled();
		// The relaunch child must run under the SAME foreground process group:
		// a fire-and-forget spawn lets the shell reclaim the tty and the kernel
		// denies the orphaned child's setRawMode with EIO (the reported crash).
		expect(spawnSync).toHaveBeenCalledTimes(1);
		expect(spawnSync).toHaveBeenCalledWith(
			process.execPath,
			[...process.execArgv, "/tmp/cli.js", "--transport", "telegram", "--profile", "alpha"],
			{ stdio: "inherit", env: expect.objectContaining({ AXIOM_HOME: "/tmp/probe-home" }) },
		);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(7);
		// Teardown completes BEFORE the blocking relaunch spawns.
		const drainOrder = fakeThis.ui.terminal.drainInput.mock.invocationCallOrder[0]!;
		const stopOrder = fakeThis.stop.mock.invocationCallOrder[0]!;
		const spawnOrder = spawnSync.mock.invocationCallOrder[0]!;
		expect(drainOrder).toBeLessThan(stopOrder);
		expect(stopOrder).toBeLessThan(spawnOrder);
	});

	it("keeps the environment unchanged and strips the old profile flags for a project switch", async () => {
		const { spawnSync, exit, deps } = makeDeps();
		const fakeThis = makeThis();
		process.argv = ["node", "/tmp/cli.js", "--profile", "old"];

		await expect(prototype.switchWorkspace.call(fakeThis, { project: "acme" }, deps)).rejects.toThrow(
			"process.exit(7)",
		);

		expect(spawnSync).toHaveBeenCalledWith(
			process.execPath,
			[...process.execArgv, "/tmp/cli.js", "--project", "acme"],
			{ stdio: "inherit", env: process.env },
		);
		expect(exit).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(7);
	});
});
