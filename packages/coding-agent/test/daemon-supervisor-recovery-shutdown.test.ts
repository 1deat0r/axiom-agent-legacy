import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const supervisorRegistryDirEnv = "AXIOM_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

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
	intentionalStop: boolean;
	recovery?: Promise<void>;
	deferredRecovery?: Promise<void>;
}

interface SupervisorInternals {
	workers: Map<string, WorkerFixture>;
	catalog: { resolve: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
	stopWorker: ReturnType<typeof vi.fn>;
	log: ReturnType<typeof vi.fn>;
	shuttingDown: boolean;
	assertRecoveryAllowed(): Promise<void>;
	shutdown(exitCode: number, stopWorkers: boolean): Promise<never>;
}

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function makeWorker(workerId: string): WorkerFixture {
	return {
		descriptor: {
			workerId,
			lifecycle: "ready",
			rootActiveSessionId: `${workerId}-root`,
			rootSessionId: `${workerId}-session`,
			pid: 1_000_000,
			createCommand: { type: "create" },
		},
		intentionalStop: false,
	};
}

function makeSupervisor(): { directory: string; supervisor: SupervisorInternals } {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-recovery-shutdown-"));
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
	return { directory, supervisor };
}

function installExitSpy(): ReturnType<typeof vi.spyOn> {
	return vi.spyOn(process, "exit").mockImplementation(
		fromPartial<typeof process.exit>((code?: string | number | null) => {
			throw new Error(`exit ${code}`);
		}),
	);
}

describe("daemon supervisor recovery vs shutdown admission", () => {
	it("rejects worker recovery on a shutting-down supervisor even without a shutdown admission record", async () => {
		const { directory, supervisor } = makeSupervisor();
		const registryDir = join(directory, "registry");
		mkdirSync(registryDir, { recursive: true });
		const previousRegistry = process.env[supervisorRegistryDirEnv];
		process.env[supervisorRegistryDirEnv] = registryDir;
		try {
			const ownership = await acquireDaemonSupervisorOwnership({
				socketPath: join(directory, "daemon.sock"),
				descriptorDir: join(directory, "workers"),
				agentDir: directory,
				generation: "test-generation",
				appVersion: "test",
				registryDir,
			});
			Reflect.set(supervisor, "ownership", ownership);
			try {
				supervisor.shuttingDown = true;
				await expect(supervisor.assertRecoveryAllowed()).rejects.toMatchObject({
					code: "supervisor_recovery_cancelled",
				});
			} finally {
				await ownership.release();
			}
		} finally {
			if (previousRegistry === undefined) delete process.env[supervisorRegistryDirEnv];
			else process.env[supervisorRegistryDirEnv] = previousRegistry;
		}
	});

	it("awaits in-flight worker recovery and deferred recovery before stopping workers at shutdown", async () => {
		const { supervisor } = makeSupervisor();
		const worker = makeWorker("recovering");
		supervisor.workers.set("recovering", worker);
		supervisor.stopWorker = vi.fn(async () => undefined);
		let releaseRecovery: () => void = () => undefined;
		let releaseDeferred: () => void = () => undefined;
		worker.recovery = new Promise<void>((resolveRecovery) => {
			releaseRecovery = resolveRecovery;
		});
		worker.deferredRecovery = new Promise<void>((resolveDeferred) => {
			releaseDeferred = resolveDeferred;
		});
		const exit = installExitSpy();

		const shutdown = supervisor.shutdown(0, true).then(
			() => undefined,
			(error: unknown) => error,
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		releaseRecovery();
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		releaseDeferred();
		await expect(shutdown).resolves.toEqual(new Error("exit 0"));
		expect(supervisor.stopWorker).toHaveBeenCalledTimes(1);
		expect(exit).toHaveBeenCalledWith(0);
	});
});
