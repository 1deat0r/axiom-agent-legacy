import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ForkServerUnavailable, forkKernel, isForkServerEnabled } from "../src/core/kernel/fork-server.js";

const FORK_ENV = "AXIOM_KERNEL_FORKSERVER";

describe("fork-server gating", () => {
	afterEach(() => {
		delete process.env[FORK_ENV];
	});

	it("is on by default on linux, opt-out via the flag", () => {
		delete process.env[FORK_ENV];
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
		process.env[FORK_ENV] = "0";
		expect(isForkServerEnabled()).toBe(false);
		process.env[FORK_ENV] = "1";
		expect(isForkServerEnabled()).toBe(process.platform === "linux");
	});

	it("rejects with ForkServerUnavailable when opted out so callers fall back", async () => {
		process.env[FORK_ENV] = "0";
		await expect(forkKernel("python3", { connectionPath: "/tmp/nope/connection.json" })).rejects.toBeInstanceOf(
			ForkServerUnavailable,
		);
	});

	it("degrades to ForkServerUnavailable when the interpreter can't start", async () => {
		if (process.platform !== "linux") return;
		// The spawn errors immediately (ENOENT), so markDead fails the ready promise
		// fast rather than waiting out the ready timeout.
		await expect(
			forkKernel("/nonexistent/python-binary", { connectionPath: "/tmp/nope/connection.json" }),
		).rejects.toBeInstanceOf(ForkServerUnavailable);
	}, 15_000);

	it("falls back to direct spawn for any PYTHON* startup-env override", async () => {
		if (process.platform !== "linux") return;
		// The guard treats the whole PYTHON* family as startup-affecting, so even a var
		// not explicitly enumerated diverts to direct spawn (no var can be "missed").
		for (const key of ["PYTHONPATH", "PYTHONUSERBASE", "PYTHONDONTWRITEBYTECODE"]) {
			await expect(
				forkKernel("python3", {
					connectionPath: "/tmp/nope/connection.json",
					env: { [key]: "/some/custom/value" },
				}),
			).rejects.toBeInstanceOf(ForkServerUnavailable);
		}
	});
});

// ---- orphan cleanup (issue #61, ADR-0076 finding 5) ------------------------

const fixturePath = resolve(__dirname, "fixtures/forkserver-orphan-fixture.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const tsConfigPath = resolve(__dirname, "../../../tsconfig.json");

/** Find a python that can run the forkserver template (import ipykernel), or null to skip. */
function resolveKernelPython(): string | null {
	const candidates = [
		process.env.AXIOM_KERNEL_PYTHON,
		join(homedir(), ".axiom", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python && process.platform === "linux" ? describe : describe.skip;

describeIfKernel("forkserver orphan cleanup (real kernel)", () => {
	const children = new Set<ChildProcess>();
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		children.clear();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function waitFor(predicate: () => boolean, timeoutMs: number, message: string): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error(message);
	}

	it("terminates the forked kernel and removes the socket dir when the host dies uncleanly", async () => {
		// The fixture forks a real kernel and reports the kernel pid plus the
		// forkserver socket dir, then idles. SIGKILLing it is an unclean host death:
		// no dispose path runs, so the forkserver must clean up its own children and
		// socket dir (PDEATHSIG + socket-EOF shutdown) rather than orphaning them.
		const connDir = mkdtempSync(join(tmpdir(), "forkserver-orphan-conn-"));
		tempDirs.push(connDir);
		writeFileSync(
			join(connDir, "connection.json"),
			JSON.stringify({
				ip: "127.0.0.1",
				transport: "tcp",
				shell_port: 0,
				iopub_port: 0,
				stdin_port: 0,
				control_port: 0,
				hb_port: 0,
				signature_scheme: "hmac-sha256",
				key: "ab".repeat(16),
				kernel_name: "python3",
			}),
		);

		const child = spawn(process.execPath, [tsxPath, fixturePath, python as string, connDir], {
			env: { ...process.env, TSX_TSCONFIG_PATH: tsConfigPath },
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.add(child);

		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		// Wait for the fixture to fork a kernel and report its pids/dirs.
		await waitFor(() => stdout.includes("READY") || stderr.includes("FORK_FAILED"), 30_000, "fixture never reported");

		if (!stdout.includes("READY")) {
			throw new Error(`fixture could not fork a kernel: ${stderr.trim()}`);
		}

		const fixturePidMatch = /FIXTURE_PID=(\d+)/.exec(stdout);
		const kernelPidMatch = /KERNEL_PID=(\d+)/.exec(stdout);
		const socketDirsMatch = /SOCKET_DIRS=(\[.*\])/.exec(stdout);
		if (!fixturePidMatch || !kernelPidMatch || !socketDirsMatch) {
			throw new Error(`fixture output missing pids/dirs: ${stdout}`);
		}
		const fixturePid = Number(fixturePidMatch[1]);
		const kernelPid = Number(kernelPidMatch[1]);
		const socketDirs = JSON.parse(socketDirsMatch[1]) as string[];

		expect(socketDirs.length).toBe(1);
		const socketDir = socketDirs[0];
		expect(existsSync(socketDir)).toBe(true);

		// The kernel is alive before the host dies.
		expect(isProcessAlive(kernelPid)).toBe(true);

		// Unclean host death: SIGKILL the fixture host (by its own pid — the tsx
		// launcher re-execs it as a grandchild, so the launcher handle is not it),
		// bypassing every dispose path.
		process.kill(fixturePid, "SIGKILL");
		await new Promise<void>((r) => child.once("exit", () => r()));

		// The forked kernel must not linger as an orphan: the forkserver's shutdown
		// (PDEATHSIG SIGTERM / socket-EOF finally) kills it.
		await waitFor(() => !isProcessAlive(kernelPid), 15_000, `forked kernel ${kernelPid} orphaned after host death`);

		// The /tmp forkserver dir must not linger either.
		await waitFor(() => !existsSync(socketDir), 15_000, `forkserver socket dir lingered: ${socketDir}`);
	}, 60_000);
});

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
