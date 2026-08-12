import { describe, expect, it } from "vitest";
import { firstToken, isCommandText, toGatewayMessage } from "../../src/gateway/messages.js";

describe("isCommandText", () => {
	it("true for a leading / command", () => {
		expect(isCommandText("/help")).toBe(true);
		expect(isCommandText("/profiles create bob")).toBe(true);
	});
	it("false for prose, empty, and comment-style", () => {
		expect(isCommandText("tell me about profiles")).toBe(false);
		expect(isCommandText("")).toBe(false);
		expect(isCommandText("//not a command")).toBe(false);
	});
});

describe("firstToken", () => {
	it("splits on whitespace", () => {
		expect(firstToken("/profiles create bob")).toBe("/profiles");
		expect(firstToken("hello world")).toBe("hello");
		expect(firstToken("solo")).toBe("solo");
	});
});

describe("toGatewayMessage", () => {
	it("normalizes a raw transport event and flags commands", () => {
		const msg = toGatewayMessage({ channelId: "+1", sender: "+1", text: "/help" });
		expect(msg.isCommand).toBe(true);
		expect(msg.channelId).toBe("+1");
		expect(msg.timestamp).toBeGreaterThan(0);
	});
});
