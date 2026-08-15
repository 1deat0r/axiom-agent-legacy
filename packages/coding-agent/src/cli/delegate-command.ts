/**
 * `axiom delegate` — see what delegate helpers do, from the terminal.
 *
 * Every delegate run writes an activity journal (see
 * extensions/delegate/journal.ts). `list` scans the journals directory;
 * `watch` tails one journal live in a full-screen TUI (or prints a one-shot
 * tail when stdout is not a terminal). --json gives scripts the raw records.
 *
 * Returns true when the invocation was a delegate command.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { detectStyle } from "../core/peers/render.js";
import { type DelegateJournalRecord, findLastRecord, readDelegateJournal } from "../extensions/delegate/journal.js";
import { runDelegateWatchTui } from "../extensions/delegate/watch-tui.js";
import { renderDelegateWatchView } from "../extensions/delegate/watch-view.js";

export const DELEGATE_HELP = `axiom delegate — see what delegate helpers do

usage:
  axiom delegate list [--json]          list recent runs (newest first)
  axiom delegate watch <handle|path>    watch a run live (q quits)
  axiom delegate watch <handle> --json  dump the journal records

journals live under <agent-dir>/delegate-results/<handle>.journal.jsonl`;

export interface DelegateCommandDeps {
	resultsDir?: string;
	now?: number;
	isTTY?: boolean;
}

/** Map a bare handle or a path to the journal file to watch. */
export function resolveDelegateJournalTarget(arg: string, resultsDir: string): string {
	if (arg.includes("/") || arg.endsWith(".journal.jsonl")) {
		return arg;
	}
	return join(resultsDir, `${arg}.journal.jsonl`);
}

interface DelegateListEntry {
	handle: string;
	task: string;
	model?: string;
	status: "running" | "done" | "error" | "timeout";
	startedAt?: number;
	completedAt?: number;
	journalFile: string;
}

function entryFromRecords(handle: string, journalFile: string, records: DelegateJournalRecord[]): DelegateListEntry {
	const start = records.find((record) => record.type === "start");
	const end = findLastRecord(records, "end");
	return {
		handle,
		task: start?.type === "start" ? start.task : "",
		model: start?.type === "start" ? start.model : undefined,
		status: end?.type === "end" ? end.status : "running",
		startedAt: start?.t,
		completedAt: end?.t,
		journalFile,
	};
}

function listEntries(resultsDir: string): DelegateListEntry[] {
	let names: string[];
	try {
		names = readdirSync(resultsDir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".journal.jsonl"))
		.map((name) => {
			const handle = name.slice(0, -".journal.jsonl".length);
			const journalFile = join(resultsDir, name);
			return entryFromRecords(handle, journalFile, readDelegateJournal(journalFile));
		})
		.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

function renderList(entries: DelegateListEntry[], now: number): string {
	const style = detectStyle();
	const width = Math.max(40, style.width);
	const age = (startedAt?: number) =>
		startedAt === undefined ? "?" : `${Math.max(0, Math.round((now - startedAt) / 1000))}s`;
	const lines = ["HANDLE        AGE   STATUS    TASK"];
	for (const entry of entries) {
		const task = entry.task === "" ? "(no task recorded)" : entry.task;
		const suffix = entry.model ? ` (${entry.model})` : "";
		const room = Math.max(12, width - 12 - 8 - 10 - 1 - suffix.length);
		const clipped = task.length > room ? `${task.slice(0, Math.max(0, room - 1))}…` : task;
		lines.push(
			`${entry.handle.padEnd(12).slice(0, 12)}  ${age(entry.startedAt).padEnd(5)}  ${entry.status.toUpperCase().padEnd(8)}  ${clipped}${suffix}`,
		);
	}
	return lines.join("\n");
}

/** One-shot tail for non-TTY output: the painted view with a fixed height. */
function renderOneShot(journalPath: string, now: number): string {
	const records = readDelegateJournal(journalPath);
	const style = detectStyle();
	return renderDelegateWatchView(records, {
		width: style.width,
		height: 24,
		scrollOffset: 0,
		color: style.color,
		now,
	}).join("\n");
}

export async function handleDelegateCommand(args: string[], deps: DelegateCommandDeps = {}): Promise<boolean> {
	if (args[0] !== "delegate") {
		return false;
	}
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("help") || rest.length === 0) {
		console.log(DELEGATE_HELP);
		return true;
	}
	const resultsDir = deps.resultsDir ?? join(getAgentDir(), "delegate-results");
	const now = deps.now ?? Date.now();
	const isTTY = deps.isTTY ?? process.stdout.isTTY;
	const sub = rest.find((arg) => !arg.startsWith("--")) ?? "list";

	try {
		if (sub === "list") {
			const json = rest.includes("--json");
			const entries = listEntries(resultsDir);
			if (json) {
				console.log(JSON.stringify(entries, null, 2));
				return true;
			}
			if (entries.length === 0) {
				console.log(`no delegate journals under ${resultsDir}`);
				return true;
			}
			console.log(renderList(entries, now));
			return true;
		}
		if (sub === "watch") {
			const targetArg = rest.find((arg) => !arg.startsWith("--") && arg !== "watch");
			if (!targetArg) {
				console.log(DELEGATE_HELP);
				return true;
			}
			const journalPath = resolveDelegateJournalTarget(targetArg, resultsDir);
			const json = rest.includes("--json");
			if (json) {
				console.log(JSON.stringify(readDelegateJournal(journalPath), null, 2));
				return true;
			}
			if (!existsSync(journalPath)) {
				process.stderr.write(`axiom delegate: no journal for "${targetArg}" (looked at ${journalPath})\n`);
				return true;
			}
			if (isTTY) {
				await runDelegateWatchTui(journalPath);
				return true;
			}
			console.log(renderOneShot(journalPath, now));
			return true;
		}
		console.log(DELEGATE_HELP);
		return true;
	} catch (error) {
		process.stderr.write(`axiom delegate: ${(error as Error).message}\n`);
		return true;
	}
}
