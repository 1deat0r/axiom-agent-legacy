import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { REFINE_REQUEST_TIMEOUT_MS, RpcClient } from "../src/modes/rpc/rpc-client.js";

type RpcClientPrivate = {
	send: (command: { type: string }, timeoutMs?: number) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

describe("RpcClient refine", () => {
	it("sends the refine command with the extended timeout", async () => {
		const client = new RpcClient();
		const privateClient = fromAny<RpcClientPrivate, unknown>(client);
		const send = vi.fn(async () => ({
			type: "response",
			command: "refine",
			success: true,
			data: { id: "refine_1", appliedEdits: [], harnessStatePath: "/tmp/harness_state.json" },
		}));
		privateClient.send = send;
		privateClient.getData = <T>(response: unknown): T => {
			return fromAny<{ data: T }, unknown>(response).data;
		};

		const result = await client.refine({ instructions: "tighten validation" });

		expect(send).toHaveBeenCalledWith(
			{ type: "refine", instructions: "tighten validation" },
			REFINE_REQUEST_TIMEOUT_MS,
		);
		expect(REFINE_REQUEST_TIMEOUT_MS).toBeGreaterThan(30000);
		expect(result).toMatchObject({ id: "refine_1" });
	});
});
