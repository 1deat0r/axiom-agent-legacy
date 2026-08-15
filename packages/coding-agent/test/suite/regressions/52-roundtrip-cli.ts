import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBundledSkillsDir } from "../../../src/config.js";
import type { KernelManager } from "../../../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../../../src/core/skills.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";

const ROUNDS = Number(process.argv[2] ?? "3");
const TAG = process.argv[3] ?? "cli";
const MARK = process.argv[4] ?? "/tmp/52-marks.log";

function mark(text: string): void {
	try {
		appendFileSync(MARK, `${Date.now()} [${TAG}] ${text}\n`);
	} catch {
		/* best-effort */
	}
}

function agentMessageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "agent-message");
	return {
		name: "agent-message",
		importName: "agent_message",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

async function roundTrip(round: number): Promise<string> {
	const dir = join(tmpdir(), `pi-stall-${TAG}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const provisioner = new IpythonKernelProvisioner(dir, {
		pythonSkills: [agentMessageSkill()],
		hostHandlers: {
			"agent_message.send": async (p: { message?: string }) => {
				mark(`host send handled round=${round}`);
				return {
					receipts: [
						{
							id: "r1",
							source: "agent_message",
							message: p.message ?? "",
							deliveryStatus: "delivered",
							deliveredAt: "x",
							deliveryMode: "direct",
						},
					],
				};
			},
		},
	});
	try {
		const manager: KernelManager = await provisioner.ensure();
		mark(`ensure done round=${round}`);
		const result = await manager.execute(
			`import agent_message\nmark_fd = open(${JSON.stringify(MARK)}, "a")\nmark_fd.write("kernel-cell-open ${TAG}\\n")\nmark_fd.flush()\nreceipt = await agent_message.send("all", "status")\nmark_fd.write("kernel-cell-reply\\n")\nmark_fd.flush()\nmark_fd.close()\nprint("RECEIPTS", len(receipt.get("receipts", [])))`,
			{},
		);
		return result.status === "ok" ? "ok" : `bad:${result.status}:${result.stdout.slice(0, 200).replace(/\n/g, " ")}`;
	} catch (error) {
		return `err:${error instanceof Error ? error.message.slice(0, 80) : String(error)}`;
	} finally {
		await provisioner.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

let fails = 0;
for (let round = 0; round < ROUNDS; round += 1) {
	const start = Date.now();
	const outcome = await roundTrip(round);
	console.log(`[${TAG}] round ${round}: ${outcome} (${Date.now() - start}ms)`);
	if (!outcome.startsWith("ok")) fails += 1;
}
process.exit(fails > 0 ? 1 : 0);
