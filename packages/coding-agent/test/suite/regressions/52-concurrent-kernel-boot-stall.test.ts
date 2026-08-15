import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KernelManager } from "../../../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";

/**
 * Regression repro for issue #52: the kernel host bridge stalls when two
 * provisioners boot concurrently. Each cell awaits a host_request reply;
 * a stall leaves the future unresolved and the cell hangs.
 */
describe("concurrent kernel boots do not stall the host bridge (issue #52)", { timeout: 120_000 }, () => {
	const HOST_CELL = `
import rlm
result = await rlm.host_request("echo.test", {"value": 42})
print("REPLY", result.get("value"))
`;

	async function bootAndRoundTrip(name: string, onEcho: () => Promise<{ value: number }>): Promise<string> {
		const dir = join(tmpdir(), `pi-stall-repro-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		const provisioner = new IpythonKernelProvisioner(dir, {
			hostHandlers: { "echo.test": onEcho },
		});
		try {
			const manager: KernelManager = await provisioner.ensure();
			const result = await manager.execute(HOST_CELL, {});
			if (result.status !== "ok") {
				return `status=${result.status}`;
			}
			return result.stdout.includes("REPLY 42") ? "ok" : `bad stdout: ${result.stdout}`;
		} finally {
			await provisioner.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("round-trips host requests from two concurrently booting kernels, 4 rounds", async () => {
		for (let round = 0; round < 4; round += 1) {
			const [a, b] = await Promise.all([
				bootAndRoundTrip("a", async () => ({ value: 42 })),
				bootAndRoundTrip("b", async () => ({ value: 42 })),
			]);
			expect(a, `round ${round} kernel a`).toBe("ok");
			expect(b, `round ${round} kernel b`).toBe("ok");
		}
	});
});
