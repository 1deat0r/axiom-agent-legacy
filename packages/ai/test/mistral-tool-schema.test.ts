import { fromAny } from "@total-typescript/shoehorn";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Context, Model } from "../src/types.js";

interface MistralToolPayload {
	tools?: Array<{
		type: "function";
		function: {
			name: string;
			parameters: Record<string, unknown>;
		};
	}>;
}

describe("Mistral tool schema serialization", () => {
	it("strips TypeBox symbol keys before the SDK validates tool schemas", async () => {
		const model: Model<"mistral-conversations"> = {
			...getModel("mistral", "devstral-medium-latest"),
			baseUrl: "http://127.0.0.1:9",
		};
		const parameters = Type.Object({
			nested: Type.Object({
				value: Type.String(),
			}),
		});
		const context: Context = {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "inspect_schema",
					description: "Inspect the schema",
					parameters,
				},
			],
		};
		let capturedPayload: MistralToolPayload | undefined;

		const response = await complete(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				capturedPayload = fromAny<MistralToolPayload, unknown>(payload);
				return payload;
			},
		});

		expect(capturedPayload?.tools).toHaveLength(1);
		const payloadParameters = capturedPayload?.tools?.[0]?.function.parameters;
		expect(payloadParameters).toBeDefined();
		expect(Object.getOwnPropertySymbols(payloadParameters ?? {})).toHaveLength(0);
		const properties = payloadParameters?.properties;
		expect(properties).toBeTruthy();
		expect(Object.getOwnPropertySymbols(fromAny<Record<string, unknown>, unknown>(properties) ?? {})).toHaveLength(0);
		const nested = fromAny<Record<string, unknown> | undefined, unknown>(properties)?.nested;
		expect(nested).toBeTruthy();
		expect(Object.getOwnPropertySymbols(fromAny<Record<string, unknown>, unknown>(nested) ?? {})).toHaveLength(0);
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage).not.toContain("Input validation failed");
	});
});
