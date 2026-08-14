/**
 * The live TUI driver for `axiom delegate watch`: a raw terminal loop over a
 * polling journal reader. The view logic lives in watch-view.ts (pure); this
 * file only owns raw mode, the poll timer, key handling, and painting.
 */

import { ProcessTerminal } from "@earendil-works/pi-tui";
import { detectStyle } from "../../core/peers/render.js";
import { readDelegateJournal } from "./journal.js";
import { renderDelegateWatchView } from "./watch-view.js";

export const WATCH_POLL_INTERVAL_MS = 250;

export interface WatchTuiOptions {
	pollMs?: number;
}

/**
 * Open the watch view on `journalPath`. Resolves when the user quits (q or
 * Ctrl-C). The journal is re-read every poll tick; a missing or partially
 * written file degrades to an empty view, never an error.
 */
export async function runDelegateWatchTui(journalPath: string, options: WatchTuiOptions = {}): Promise<void> {
	return new Promise<void>((resolve) => {
		const terminal = new ProcessTerminal();
		const style = detectStyle();
		let scrollOffset = 0;
		let stopped = false;
		let timer: NodeJS.Timeout | null = null;

		const paint = (): void => {
			if (stopped) {
				return;
			}
			const records = readDelegateJournal(journalPath);
			const lines = renderDelegateWatchView(records, {
				width: terminal.columns,
				height: terminal.rows,
				scrollOffset,
				color: style.color,
			});
			terminal.write("\u001b[H");
			// Clear each row before painting it and never emit a trailing
			// newline: one extra \r\n after the last row would scroll the
			// terminal down a line every frame.
			terminal.write(lines.map((line) => `\u001b[2K${line}`).join("\r\n"));
			terminal.write("\u001b[J");
		};

		const stop = (): void => {
			if (stopped) {
				return;
			}
			stopped = true;
			if (timer) {
				clearInterval(timer);
			}
			terminal.leaveAltScreen();
			terminal.showCursor();
			terminal.stop();
			resolve();
		};

		terminal.start(
			(data) => {
				if (data === "q" || data === "\u0003") {
					stop();
					return;
				}
				if (data === "\u001b[A" || data === "k") {
					scrollOffset += 1;
					paint();
					return;
				}
				if (data === "\u001b[B" || data === "j") {
					scrollOffset = Math.max(0, scrollOffset - 1);
					paint();
					return;
				}
				if (data === "g") {
					scrollOffset = Number.MAX_SAFE_INTEGER;
					paint();
					return;
				}
				if (data === "G") {
					scrollOffset = 0;
					paint();
					return;
				}
			},
			() => {
				paint();
			},
		);

		terminal.hideCursor();
		terminal.enterAltScreen();
		paint();
		timer = setInterval(paint, options.pollMs ?? WATCH_POLL_INTERVAL_MS);
	});
}
