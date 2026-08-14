import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor, WorkerStopTimeoutError } from "../src/modes/daemon/daemon-supervisor.js";

interface WorkerFixture {
	descriptor: {
		workerId: string;
		lifecycle: "starting" | "ready" | "recovering" | "failed";
		rootActiveSessionId: string;
		rootSessionId: string;
		pid: number;
		processStartId?: string;
		stopRequestedAt?: string;
		createCommand: { type: "create" };
	};
	client?: {
		request: ReturnType<typeof vi.fn>;
		requestWorker: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
	};
	intentionalStop: boolean;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
}

const tempDirs: string[] = [];
const sleepPids = new Set<number>();

afterEach(() => {
	vi.restoreAllMocks();
	for (const pid of sleepPids) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// The group may already be gone.
		}
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The process may already be gone.
		}
	}
	sleepPids.clear();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function spawnDetachedSleep(): { pid: number; processStartId: string } {
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	const pid = child.pid;
	if (!pid) {
		throw new Error("sleep did not expose a pid");
	}
	const processStartId = getProcessStartId(pid);
	if (!processStartId) {
		child.kill("SIGKILL");
		throw new Error("could not read the sleep start id");
	}
	sleepPids.add(pid);
	return { pid, processStartId };
}

function makeWorker(workerId: string, pid: number, processStartId?: string): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root`,
			rootSessionId: `${workerId}-session`,
			pid,
			...(processStartId !== undefined ? { processStartId } : {}),
			createCommand: { type: "create" },
		},
		intentionalStop: false,
	};
}

function makeSupervisor(): SupervisorInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-shutdown-"));
	tempDirs.push(directory);
	mkdirSync(directory, { recursive: true });
	const descriptorDir = join(directory, "workers");
	mkdirSync(descriptorDir, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({}));
	const supervisor = fromAny<SupervisorInternals, unknown>(
		new DaemonSupervisor(join(directory, "daemon.sock"), {
			defaultSessionConfig: { agentDir: directory, cwd: directory },
			descriptorDir,
		}),
	);
	supervisor.log = vi.fn();
	supervisor.catalog = {
		resolve: vi.fn(),
		stop: vi.fn(async () => undefined),
	};
	return supervisor;
}

function installExitSpy(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(
		fromPartial<typeof process.exit>((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}),
	);
}

describe("daemon supervisor shutdown last-resort worker reaping", () => {
	it("force-kills a wedged worker with a verifiable identity at shutdown", async () => {
		const { pid, processStartId } = spawnDetachedSleep();
		const supervisor = makeSupervisor();
		supervisor.stopWorker = vi.fn(async () => {
			throw new WorkerStopTimeoutError("Session worker wedged did not stop");
		});
		supervisor.workers.set("wedged", makeWorker("wedged", pid, processStartId));
		const kill = vi.spyOn(process, "kill");
		const exit = installExitSpy();

		const shutdown = supervisor.shutdown(42, true).then(
			() => undefined,
			(error: unknown) => error,
		);
		await expect(shutdown).resolves.toEqual(new Error("exit 42"));
		expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
		expect(exit).toHaveBeenCalledWith(42);
	});

	it("group-kills an unknown-identity worker at shutdown without the single-pid fallback", async () => {
		const { pid } = spawnDetachedSleep();
		const supervisor = makeSupervisor();
		supervisor.stopWorker = vi.fn(async () => {
			throw new WorkerStopTimeoutError("Session worker wedged did not stop");
		});
		supervisor.workers.set("wedged", makeWorker("wedged", pid));
		const kill = vi.spyOn(process, "kill");
		installExitSpy();

		const shutdown = supervisor.shutdown(42, true).then(
			() => undefined,
			(error: unknown) => error,
		);
		await expect(shutdown).resolves.toEqual(new Error("exit 42"));
		expect(kill).toHaveBeenCalledWith(-pid, "SIGKILL");
		expect(kill).not.toHaveBeenCalledWith(pid, "SIGKILL");
	});

	it("does not signal a replaced-identity worker at shutdown", async () => {
		const { pid } = spawnDetachedSleep();
		const supervisor = makeSupervisor();
		supervisor.stopWorker = vi.fn(async () => {
			throw new WorkerStopTimeoutError("Session worker wedged did not stop");
		});
		supervisor.workers.set("wedged", makeWorker("wedged", pid, "bogus-start-id"));
		const kill = vi.spyOn(process, "kill");
		installExitSpy();

		const shutdown = supervisor.shutdown(42, true).then(
			() => undefined,
			(error: unknown) => error,
		);
		await expect(shutdown).resolves.toEqual(new Error("exit 42"));
		expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
		expect(kill).not.toHaveBeenCalledWith(pid, "SIGKILL");
	});

	it("does not signal a gone worker at shutdown", async () => {
		const { pid, processStartId } = spawnDetachedSleep();
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Best-effort cleanup before the liveness probe.
		}
		await new Promise<void>((resolve) => {
			const poll = setInterval(() => {
				try {
					process.kill(pid, 0);
				} catch {
					clearInterval(poll);
					resolve();
				}
			}, 10);
		});
		const supervisor = makeSupervisor();
		supervisor.stopWorker = vi.fn(async () => {
			throw new WorkerStopTimeoutError("Session worker wedged did not stop");
		});
		supervisor.workers.set("wedged", makeWorker("wedged", pid, processStartId));
		const kill = vi.spyOn(process, "kill");
		installExitSpy();

		const shutdown = supervisor.shutdown(42, true).then(
			() => undefined,
			(error: unknown) => error,
		);
		await expect(shutdown).resolves.toEqual(new Error("exit 42"));
		expect(kill).not.toHaveBeenCalledWith(-pid, "SIGKILL");
		expect(kill).not.toHaveBeenCalledWith(pid, "SIGKILL");
	});
});
