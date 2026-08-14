import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent.js";
import { DEFAULT_STREAM_STALL_TIMEOUT_MS, runAgentLoop, StreamStallError } from "../src/agent-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.js";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return fromPartial<Message[]>(
		messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
	);
}

function createConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model: createModel(),
		convertToLlm: identityConverter,
		...overrides,
	};
}

function collectEvents(): { events: AgentEvent[]; emit: (event: AgentEvent) => Promise<void> } {
	const events: AgentEvent[] = [];
	return {
		events,
		emit: async (event) => {
			events.push(event);
		},
	};
}

/** A stream whose iterator never delivers and whose return() is tracked. */
class StallingStream {
	returnCalls = 0;
	private readonly pending = new Promise<IteratorResult<AssistantMessageEvent>>(() => undefined);

	[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
		return {
			next: () => this.pending,
			return: () => {
				this.returnCalls += 1;
				return Promise.resolve({ done: true, value: undefined }) as Promise<IteratorReturnResult<undefined>>;
			},
		};
	}

	result(): Promise<AssistantMessage> {
		return new Promise(() => undefined);
	}
}

/** A stream that delivers a start event, then chunk deltas on a fake-timer cadence, then done. */
function chunkedStream(chunkCount: number, intervalMs: number) {
	const stream = createAssistantMessageEventStream();
	let partial = createAssistantMessage("");
	stream.push({ type: "start", partial });
	let delivered = 0;
	const timer = setInterval(() => {
		partial = {
			...partial,
			content: [{ type: "text", text: `chunk ${delivered}` }],
		};
		stream.push({ type: "text_delta", contentIndex: 0, delta: `chunk ${delivered}`, partial });
		delivered += 1;
		if (delivered >= chunkCount) {
			clearInterval(timer);
			const final = createAssistantMessage(Array.from({ length: chunkCount }, (_, i) => `chunk ${i}`).join(" "));
			stream.push({ type: "done", reason: "stop", message: final });
		}
	}, intervalMs);
	return stream;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("stream stall watchdog", () => {
	it("aborts a stalled stream, retries once, and keeps the retry answer", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const stalled = new StallingStream();
		const streamFn = vi.fn<StreamFn>(() => {
			if (streamFn.mock.calls.length === 1) {
				return stalled as unknown as ReturnType<StreamFn>;
			}
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("recovered");
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const config = createConfig({ streamStallTimeoutMs: 1_000, streamStallMaxAttempts: 2 });
		const { events, emit } = collectEvents();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, undefined, streamFn);
		await vi.advanceTimersByTimeAsync(1_000);
		const messages = await promise;

		expect(streamFn).toHaveBeenCalledTimes(2);
		expect(stalled.returnCalls).toBeGreaterThan(0);
		const last = messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last && "content" in last && last.content[0]).toMatchObject({ type: "text", text: "recovered" });
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("fails the turn with a StreamStallError after the final attempt stalls", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => new StallingStream() as unknown as ReturnType<StreamFn>);
		const config = createConfig({ streamStallTimeoutMs: 1_000, streamStallMaxAttempts: 2 });
		const { emit } = collectEvents();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, undefined, streamFn);
		const rejection = expect(promise).rejects.toThrow(/stall/i);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await rejection;
		expect(streamFn).toHaveBeenCalledTimes(2);
	});

	it("never cuts a long generation whose chunks keep flowing", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => chunkedStream(10, 30_000) as unknown as ReturnType<StreamFn>);
		const config = createConfig({ streamStallTimeoutMs: 120_000 });
		const { emit } = collectEvents();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, undefined, streamFn);
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(30_000);
		}
		const messages = await promise;

		expect(streamFn).toHaveBeenCalledTimes(1);
		const last = messages.at(-1);
		expect(last?.role).toBe("assistant");
		const text = last && "content" in last ? (last.content[0] as { text: string }).text : "";
		expect(text).toContain("chunk 9");
	});

	it("uses the default stall timeout when the config leaves it unset", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => new StallingStream() as unknown as ReturnType<StreamFn>);
		const config = createConfig({ streamStallMaxAttempts: 1 });
		const { emit } = collectEvents();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, undefined, streamFn);
		const rejection = expect(promise).rejects.toBeInstanceOf(StreamStallError);
		await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_STALL_TIMEOUT_MS - 1);
		expect(streamFn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejection;
	});

	it("keeps parent aborts working while a stream is stalled", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => new StallingStream() as unknown as ReturnType<StreamFn>);
		const config = createConfig({ streamStallTimeoutMs: 1_000 });
		const { emit } = collectEvents();
		const controller = new AbortController();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, controller.signal, streamFn);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		const messages = await promise;

		expect(streamFn).toHaveBeenCalledTimes(1);
		const last = messages.at(-1);
		expect(last && "stopReason" in last ? last.stopReason : undefined).toBe("aborted");
	});

	it("does not retry provider errors as stalls", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => {
			throw new Error("provider exploded");
		});
		const config = createConfig({ streamStallTimeoutMs: 1_000 });
		const { emit } = collectEvents();

		await expect(
			runAgentLoop([createUserMessage("hello")], context, config, emit, undefined, streamFn),
		).rejects.toThrow("provider exploded");
		expect(streamFn).toHaveBeenCalledTimes(1);
	});

	it("records a clear failure message on the turn when every attempt stalls", async () => {
		vi.useFakeTimers();
		const streamFn = vi.fn<StreamFn>(() => new StallingStream() as unknown as ReturnType<StreamFn>);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: "", tools: [] },
			convertToLlm: identityConverter,
			streamFn,
			streamStallTimeoutMs: 1_000,
			streamStallMaxAttempts: 2,
		});

		const run = agent.prompt(createUserMessage("hello"));
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(1_000);
		await run;

		expect(streamFn).toHaveBeenCalledTimes(2);
		expect(agent.state.errorMessage).toMatch(/stalled/i);
		const last = agent.state.messages.at(-1);
		expect(last && "stopReason" in last ? last.stopReason : undefined).toBe("error");
		expect(last && "errorMessage" in last ? String(last.errorMessage) : "").toMatch(/stalled/i);
	});

	it("disables the watchdog when the stall timeout is zero", async () => {
		vi.useFakeTimers();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const streamFn = vi.fn<StreamFn>(() => new StallingStream() as unknown as ReturnType<StreamFn>);
		const config = createConfig({ streamStallTimeoutMs: 0 });
		const { emit } = collectEvents();
		const controller = new AbortController();

		const promise = runAgentLoop([createUserMessage("hello")], context, config, emit, controller.signal, streamFn);
		await vi.advanceTimersByTimeAsync(600_000);
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(1);
		expect(settled).toBe(false);
		expect(streamFn).toHaveBeenCalledTimes(1);
		controller.abort();
		await promise;
	});
});
