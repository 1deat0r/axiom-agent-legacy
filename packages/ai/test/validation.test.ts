import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

function createToolCallWithPlainSchema(
	schema: Tool["parameters"],
	value: unknown,
): {
	tool: Tool;
	toolCall: ToolCall;
} {
	const tool: Tool = {
		name: "echo",
		description: "Echo tool",
		parameters: fromPartial<Tool["parameters"]>({
			type: "object",
			properties: {
				value: schema,
			},
			required: ["value"],
		}),
	};

	const toolCall: ToolCall = {
		type: "toolCall",
		id: "tool-1",
		name: "echo",
		arguments: { value },
	};

	return { tool, toolCall };
}

describe("validateToolArguments", () => {
	it("still validates when Function constructor is unavailable", () => {
		const originalFunction = globalThis.Function;
		const tool: Tool = {
			name: "echo",
			description: "Echo tool",
			parameters: Type.Object({
				count: Type.Number(),
			}),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "echo",
			arguments: { count: fromAny<number, unknown>("42") },
		};

		globalThis.Function = fromAny<FunctionConstructor, unknown>(() => {
			throw new EvalError("Code generation from strings disallowed for this context");
		});

		try {
			expect(validateToolArguments(tool, toolCall)).toEqual({ count: 42 });
		} finally {
			globalThis.Function = originalFunction;
		}
	});

	it("coerces serialized plain JSON schemas with AJV-compatible primitive rules", () => {
		const passingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
			expected: unknown;
		}> = [
			{ schema: fromPartial<Tool["parameters"]>({ type: "number" }), input: "42", expected: 42 },
			{ schema: fromPartial<Tool["parameters"]>({ type: "number" }), input: true, expected: 1 },
			{ schema: fromPartial<Tool["parameters"]>({ type: "number" }), input: null, expected: 0 },
			{ schema: fromPartial<Tool["parameters"]>({ type: "integer" }), input: "42", expected: 42 },
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: "true", expected: true },
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: "false", expected: false },
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: 1, expected: true },
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: 0, expected: false },
			{ schema: fromPartial<Tool["parameters"]>({ type: "string" }), input: null, expected: "" },
			{ schema: fromPartial<Tool["parameters"]>({ type: "string" }), input: true, expected: "true" },
			{ schema: fromPartial<Tool["parameters"]>({ type: "null" }), input: "", expected: null },
			{ schema: fromPartial<Tool["parameters"]>({ type: "null" }), input: 0, expected: null },
			{ schema: fromPartial<Tool["parameters"]>({ type: "null" }), input: false, expected: null },
			{
				schema: fromPartial<Tool["parameters"]>({ type: ["number", "string"] }),
				input: "1",
				expected: "1",
			},
			{
				schema: fromPartial<Tool["parameters"]>({ type: ["boolean", "number"] }),
				input: "1",
				expected: 1,
			},
		];

		for (const testCase of passingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(validateToolArguments(tool, toolCall)).toEqual({ value: testCase.expected });
		}
	});

	it("rejects invalid coercions for serialized plain JSON schemas", () => {
		const failingCases: Array<{
			schema: Tool["parameters"];
			input: unknown;
		}> = [
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: "1" },
			{ schema: fromPartial<Tool["parameters"]>({ type: "boolean" }), input: "0" },
			{ schema: fromPartial<Tool["parameters"]>({ type: "null" }), input: "null" },
			{ schema: fromPartial<Tool["parameters"]>({ type: "integer" }), input: "42.1" },
		];

		for (const testCase of failingCases) {
			const { tool, toolCall } = createToolCallWithPlainSchema(testCase.schema, testCase.input);
			expect(() => validateToolArguments(tool, toolCall)).toThrow("Validation failed");
		}
	});
});
