#!/usr/bin/env node
/**
 * Latency probe analyzer: summarize one agent session JSONL.
 *
 * Usage: node tools/latency-probe/analyze.mjs <session.jsonl>
 *
 * Prints: wall time (first->last entry), assistant turns, tool calls,
 * tool-call batches (messages with >1 tool call = parallel batches),
 * total thinking tokens, and per-turn median delta.
 *
 * A/B recipe (see RUN.md): run the same fixed task on a fresh session
 * before and after a change, then compare turns + wall time.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
	console.error("usage: node analyze.mjs <session.jsonl>");
	process.exit(2);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const entries = [];
for (const line of lines) {
	try {
		entries.push(JSON.parse(line));
	} catch {
		// tolerate partial/duplicate header lines
	}
}

const messages = entries.filter((e) => e.type === "message" && e.message);
const assistant = messages.filter((m) => m.message.role === "assistant");
const toolCalls = assistant.flatMap((m) =>
	(m.message.content ?? []).filter((c) => c.type === "toolCall"),
);
const batches = assistant.filter(
	(m) => (m.message.content ?? []).filter((c) => c.type === "toolCall").length > 1,
);
const thinkingTokens = assistant.reduce((sum, m) => {
	const thinking = (m.message.content ?? []).filter((c) => c.type === "thinking");
	return sum + thinking.reduce((s, t) => s + (t.thinking?.length ?? 0), 0);
}, 0);

const times = messages.map((m) => new Date(m.timestamp).getTime()).filter((t) => Number.isFinite(t));
const wallMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
const deltas = [];
for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
deltas.sort((a, b) => a - b);
const median = deltas.length ? deltas[Math.floor(deltas.length / 2)] : 0;

const usage = assistant
	.map((m) => m.message.usage ?? {})
	.reduce(
		(acc, u) => ({
			input: acc.input + (u.input ?? 0),
			output: acc.output + (u.output ?? 0),
			cacheRead: acc.cacheRead + (u.cacheRead ?? 0),
		}),
		{ input: 0, output: 0, cacheRead: 0 },
	);

console.log(
	JSON.stringify(
		{
			messages: messages.length,
			assistantTurns: assistant.length,
			toolCalls: toolCalls.length,
			parallelBatches: batches.length,
			wallSeconds: +(wallMs / 1000).toFixed(1),
			medianTurnDeltaMs: median,
			thinkingChars: thinkingTokens,
			usage,
		},
		null,
		2,
	),
);
