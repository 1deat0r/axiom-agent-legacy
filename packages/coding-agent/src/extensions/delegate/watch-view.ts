/**
 * Pure state and rendering for the delegate watch view (`axiom delegate
 * watch`). No terminal IO here: the records go in, the painted screen lines
 * come out, so the layout is deterministically unit-testable and the TUI
 * driver stays a thin loop over a polling reader.
 */

import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type DelegateJournalRecord, type DelegateJournalStatus, findLastRecord } from "./journal.js";
import type { DelegateTokenAccounting } from "./types.js";

/** Derived view state over one journal's records. */
export interface DelegateWatchView {
	task: string;
	model?: string;
	status: DelegateJournalStatus | "running";
	startedAt?: number;
	elapsedMs: number;
	tokens?: DelegateTokenAccounting;
	endRecord?: Extract<DelegateJournalRecord, { type: "end" }>;
}

/** Derive the view state from records at time `now`. */
export function buildDelegateWatchView(records: DelegateJournalRecord[], now: number = Date.now()): DelegateWatchView {
	const start = records.find((record) => record.type === "start");
	const end = findLastRecord(records, "end");
	const startedAt = start?.type === "start" ? start.t : end?.type === "end" ? end.t : undefined;
	return {
		task: start?.type === "start" ? start.task : "",
		model: start?.type === "start" ? start.model : undefined,
		status: end?.type === "end" ? end.status : "running",
		startedAt,
		elapsedMs: startedAt === undefined ? 0 : Math.max(0, now - startedAt),
		tokens: end?.type === "end" ? end.tokens : undefined,
		endRecord: end,
	};
}

export interface DelegateWatchRenderOptions {
	width: number;
	height: number;
	/** Lines scrolled back from the bottom; 0 pins to the newest line. */
	scrollOffset: number;
	color?: boolean;
	now?: number;
}

const RUNNING_FOOTER = "q quit · ↑/↓ scroll · g/G jump · following";
const FINISHED_FOOTER = "finished · q quit · ↑/↓ scroll · g/G jump";

function formatStatus(status: DelegateJournalStatus | "running", color: boolean): string {
	const label = status.toUpperCase();
	if (!color) {
		return label;
	}
	return status === "running" ? chalk.yellow(label) : status === "done" ? chalk.green(label) : chalk.red(label);
}

function formatStatusLine(view: DelegateWatchView, color: boolean): string {
	const parts: string[] = [];
	if (view.model) {
		parts.push(`model: ${view.model}`);
	}
	parts.push(`status: ${formatStatus(view.status, color)}`);
	parts.push(`${Math.max(0, Math.round(view.elapsedMs / 1000))}s`);
	if (view.tokens) {
		parts.push(`tokens: ${view.tokens.total} (${view.tokens.input}/${view.tokens.output})`);
	}
	return parts.join(" · ");
}

/** One record -> the display lines it contributes, colored, not yet wrapped. */
function recordLines(record: DelegateJournalRecord, color: boolean): string[] {
	switch (record.type) {
		case "assistant": {
			return record.text === "" ? [] : [record.text];
		}
		case "tool": {
			return [color ? chalk.cyan(`→ ${record.name} ${record.args}`) : `→ ${record.name} ${record.args}`];
		}
		case "tool_done": {
			const line = `${record.isError ? "✗" : "✓"} ${record.name}`;
			return [record.isError ? (color ? chalk.red(line) : line) : color ? chalk.green(line) : line];
		}
		case "turn": {
			return [color ? chalk.dim("· turn") : "· turn"];
		}
		case "end": {
			const head = `end · ${record.status}${record.error ? ` · ${record.error}` : ""}`;
			const lines = [color ? chalk.bold(formatStatus(record.status, color) ? `${head}` : head) : head];
			if (record.summary) {
				lines.push(color ? chalk.yellow(`summary: ${record.summary}`) : `summary: ${record.summary}`);
			}
			return lines;
		}
		default: {
			return [];
		}
	}
}

/** All body lines (wrapped to `width`), oldest first. */
function buildBodyLines(records: DelegateJournalRecord[], width: number, color: boolean): string[] {
	const lines: string[] = [];
	for (const record of records) {
		for (const line of recordLines(record, color)) {
			lines.push(...wrapTextWithAnsi(line, width));
		}
	}
	return lines;
}

/**
 * Paint the full watch screen: header (task, status line), separator, body
 * window (pinned to the newest line unless scrolled back), footer. Returns
 * exactly `height` lines.
 */
export function renderDelegateWatchView(
	records: DelegateJournalRecord[],
	options: DelegateWatchRenderOptions,
): string[] {
	const width = Math.max(20, Math.floor(options.width));
	const height = Math.max(4, Math.floor(options.height));
	const color = options.color === true;
	const view = buildDelegateWatchView(records, options.now ?? Date.now());
	const header = [`task: ${truncateToWidth(view.task, width)}`, formatStatusLine(view, color)];
	const separator = "─".repeat(width);
	const available = height - 4;
	const body = buildBodyLines(records, width, color);
	const maxOffset = Math.max(0, body.length - available);
	const offset = Math.min(Math.max(0, Math.floor(options.scrollOffset)), maxOffset);
	const start = Math.max(0, body.length - available - offset);
	const visible = body.slice(start, body.length - offset);
	const lines = [...header, separator, ...visible];
	while (lines.length < height - 1) {
		lines.push("");
	}
	lines.push(view.status === "running" ? RUNNING_FOOTER : FINISHED_FOOTER);
	return lines.slice(0, height);
}
