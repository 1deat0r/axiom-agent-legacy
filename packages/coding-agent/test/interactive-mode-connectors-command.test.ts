import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { defaultGatewayServiceDeps } from "../src/cli/gateway-service.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type InteractiveModePrototype = {
	handleConnectorsSlashCommand(
		this: { printLocalLines(lines: string[]): void; openConnectorsMenu?(deps: unknown): Promise<void> },
		args: string,
		deps?: unknown,
	): Promise<void>;
};

const prototype = fromAny<InteractiveModePrototype, unknown>(InteractiveMode.prototype);

function makeDeps() {
	const deps = defaultGatewayServiceDeps();
	const calls: string[] = [];
	return {
		deps: {
			...deps,
			serviceName: "axiom-telegram-gateway.service",
			envFilePath: "/tmp/axiom-probe.env",
			exec: async (command: string, args: string[]) => {
				calls.push(`${command} ${args.join(" ")}`);
				if (command === "systemctl" && args[1] === "show") {
					return { code: 1, stdout: "", stderr: "no unit" };
				}
				return { code: 0, stdout: "", stderr: "" };
			},
			readFile: () => {
				throw new Error("no file");
			},
			writeFile: () => undefined,
			env: {},
			cgroupPath: "/tmp/axiom-probe.cgroup",
		},
		calls,
	};
}

describe("InteractiveMode /connectors dispatch", () => {
	it("prints status lines into the chat for /connectors status", async () => {
		const { deps } = makeDeps();
		const printed: string[] = [];
		await prototype.handleConnectorsSlashCommand.call(
			{ printLocalLines: (l: string[]) => printed.push(...l) },
			"status",
			deps,
		);
		expect(printed[0]).toContain("axiom-telegram-gateway.service");
		expect(printed.join("\n")).toContain("signal —");
		expect(printed.join("\n")).toContain("telegram —");
	});

	it("prints the setup guide for /connectors help <name>", async () => {
		const { deps } = makeDeps();
		const printed: string[] = [];
		await prototype.handleConnectorsSlashCommand.call(
			{ printLocalLines: (l: string[]) => printed.push(...l) },
			"help telegram",
			deps,
		);
		expect(printed.join("\n")).toContain("AXIOM_TELEGRAM_BOT_TOKEN");
		expect(printed.join("\n")).toContain("@BotFather");
	});

	it("opens the menu for a bare /connectors", async () => {
		const { deps } = makeDeps();
		const openConnectorsMenu = vi.fn().mockResolvedValue(undefined);
		await prototype.handleConnectorsSlashCommand.call(
			{ printLocalLines: () => undefined, openConnectorsMenu },
			"",
			deps,
		);
		expect(openConnectorsMenu).toHaveBeenCalledWith(deps);
	});

	it("prints usage for unknown argument forms", async () => {
		const { deps } = makeDeps();
		const printed: string[] = [];
		await prototype.handleConnectorsSlashCommand.call(
			{ printLocalLines: (l: string[]) => printed.push(...l) },
			"bogus",
			deps,
		);
		expect(printed.join("\n")).toContain("usage");
	});
});
