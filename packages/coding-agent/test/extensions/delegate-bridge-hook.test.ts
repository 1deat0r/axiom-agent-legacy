import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";
import { createRpcClientBridge } from "../../src/extensions/delegate/bridge.js";

describe("delegate bridge event hook", () => {
	it("forwards every helper agent event to the onEvent hook in order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "delegate-hook-"));
		const probePath = join(dir, "probe.mjs");
		writeFileSync(
			probePath,
			[
				'import { createInterface } from "node:readline";',
				"const rl = createInterface({ input: process.stdin });",
				'const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");',
				'rl.on("line", (line) => {',
				"  let cmd;",
				"  try { cmd = JSON.parse(line); } catch { return; }",
				'  if (cmd.type === "prompt") {',
				'    out({ id: cmd.id, type: "response", command: "prompt", success: true });',
				'    out({ type: "agent_start" });',
				'    out({ type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: {} } });',
				'    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });',
				'    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false });',
				'    out({ type: "agent_end", messages: [] });',
				'  } else if (cmd.type === "get_last_assistant_text") {',
				'    out({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "probe" } });',
				'  } else if (cmd.type === "get_session_stats") {',
				'    out({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: { sessionFile: null, sessionId: "probe", userMessages: 0, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 } });',
				"  }",
				"});",
				"setInterval(() => {}, 60000);",
			].join("\n"),
		);
		const seen: AgentEvent[] = [];
		const bridge = createRpcClientBridge({ cliPath: probePath });
		bridge.onEvent = (event) => {
			seen.push(event);
		};
		try {
			await bridge.start();
			await bridge.runTask("t", 10_000);
			expect(seen.map((event) => event.type)).toEqual([
				"agent_start",
				"message_update",
				"tool_execution_start",
				"tool_execution_end",
				"agent_end",
			]);
			const delta = fromAny<{ assistantMessageEvent: { delta: string } }, unknown>(seen[1]!);
			expect(delta.assistantMessageEvent.delta).toBe("hi");
			const tool = fromAny<{ toolName: string; args: { command: string } }, unknown>(seen[2]!);
			expect(tool.toolName).toBe("bash");
			expect(tool.args.command).toBe("ls");
		} finally {
			await bridge.stop();
		}
		expect(existsSync(probePath)).toBe(true);
	}, 30_000);
});
