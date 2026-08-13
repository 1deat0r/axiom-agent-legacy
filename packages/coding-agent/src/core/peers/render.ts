/**
 * Terminal rendering for peer state (ADR-0038 follow-up): aligned tables,
 * relative timestamps, status glyphs, and ANSI color that respects the TTY,
 * NO_COLOR, and FORCE_COLOR conventions. The model-facing plain text lives in
 * format.ts; this module is what humans see at the terminal.
 */

import type { BoardEntry, PeerSummary, PeersListResult } from "./types.js";

export interface RenderStyle {
	/** Emit ANSI colors. */
	color: boolean;
	/** Show "2m ago" instead of ISO timestamps. */
	relativeTime: boolean;
	/** Terminal width the layout targets. */
	width: number;
	/** Clock used for relative times. */
	now: number;
}

const RESET = "\x1b[0m";
function paint(enabled: boolean, code: string): (s: string) => string {
	return enabled ? (s) => `\x1b[${code}m${s}${RESET}` : (s) => s;
}

const GREEN = "32";
const DIM = "2";
const CYAN = "36";
const MAGENTA = "35";

/**
 * Resolve render style from the environment: FORCE_COLOR wins, NO_COLOR
 * disables, otherwise follow the TTY. Width is clamped to [80, 120].
 */
export function detectStyle(
	env: Record<string, string | undefined> = process.env,
	isTTY: boolean = process.stdout.isTTY,
	columns: number | undefined = process.stdout.columns,
): RenderStyle {
	const force = env.FORCE_COLOR;
	const color = force !== undefined && force !== "0" ? true : env.NO_COLOR !== undefined ? false : isTTY;
	const raw = typeof columns === "number" && Number.isFinite(columns) ? columns : 80;
	return { color, relativeTime: true, width: Math.min(120, Math.max(80, raw)), now: Date.now() };
}

/** "just now", "2m ago", "3h ago", "5d ago", then a date for older entries. */
export function relativeTime(iso: string, now: number): string {
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return "unknown";
	const delta = now - ts;
	if (delta < 45_000) return "just now";
	if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / 3_600_000)}h ago`;
	if (delta < 7 * 24 * 60 * 60_000) return `${Math.floor(delta / 86_400_000)}d ago`;
	return iso.slice(0, 10);
}

function ellipsize(s: string, width: number): string {
	if (s.length <= width) return s;
	return width <= 1 ? "…" : `${s.slice(0, width - 1)}…`;
}

function pad(s: string, width: number): string {
	return s.length >= width ? s : `${s}${" ".repeat(width - s.length)}`;
}

function seen(s: PeerSummary, style: RenderStyle): string {
	return style.relativeTime ? relativeTime(s.lastSeen, style.now) : s.lastSeen;
}

export interface RenderPeersListOptions {
	selfShortId?: string;
	projectLabel?: string;
	unread?: number;
	style: RenderStyle;
}

/** Human-facing peers table: status glyphs, aligned columns, legend footer. */
export function renderPeersList(result: PeersListResult, options: RenderPeersListOptions): string {
	const { style } = options;
	const green = paint(style.color, GREEN);
	const dim = paint(style.color, DIM);
	const title = `peers in ${options.projectLabel ?? "this project"}${options.selfShortId ? ` — you: ${options.selfShortId}` : ""}`;
	const unread = options.unread ?? 0;
	if (result.active.length === 0 && result.stale.length === 0 && result.self.length === 0) {
		return `${title}\n\n  (no other instances here right now)\n\n${legend(style, unread)}`;
	}

	const rows: Array<{ s: PeerSummary; glyph: string; tag: string }> = [
		...result.active.map((s) => ({ s, glyph: green("●"), tag: "" })),
		...result.stale.map((s) => ({ s, glyph: dim("○"), tag: "" })),
		...result.self.map((s) => ({ s, glyph: green("●"), tag: dim("· you") })),
	];

	const modelW = Math.min(24, Math.max(...rows.map((r) => (r.s.model || "—").length)));
	const seenW = Math.max(...rows.map((r) => seen(r.s, style).length));
	const fixed = 4 + 8 + 2 + modelW + 2 + seenW + 2;
	const intentW = Math.min(64, Math.max(24, style.width - fixed));

	const lines = [title, ""];
	for (const row of rows) {
		const model = pad(ellipsize(row.s.model || "—", modelW), modelW);
		const intent = row.s.intent ? `"${ellipsize(row.s.intent, Math.max(4, intentW - 2))}"` : "(none)";
		const intentCol = pad(intent, intentW);
		lines.push(
			`  ${row.glyph} ${pad(row.s.shortId, 8)}  ${model}  ${intentCol}  ${pad(seen(row.s, style), seenW)}${row.tag ? `  ${row.tag}` : ""}`,
		);
	}
	lines.push("", legend(style, unread));
	return lines.join("\n");
}

function legend(style: RenderStyle, unread: number): string {
	const green = paint(style.color, GREEN);
	const dim = paint(style.color, DIM);
	const parts = [`${green("●")} active`, `${dim("○")} stale (crashed or idle)`];
	if (unread > 0) parts.push(`${unread} unread message${unread === 1 ? "" : "s"} — axiom peers inbox`);
	return parts.join(" · ");
}

/** Human-facing inbox: colored kind badges, sender, relative time, message body. */
export function renderInbox(messages: BoardEntry[], style: RenderStyle): string {
	if (messages.length === 0) return "peer inbox is empty";
	const cyan = paint(style.color, CYAN);
	const magenta = paint(style.color, MAGENTA);
	const dim = paint(style.color, DIM);
	const lines = [`peer inbox — ${messages.length} unread`, ""];
	for (const m of messages) {
		const badge = m.kind === "group" ? cyan("[group]") : magenta("[msg]  ");
		const when = style.relativeTime ? relativeTime(m.ts, style.now) : m.ts;
		lines.push(`  ${badge} ${m.from.slice(0, 8)} · ${when}`);
		lines.push(`    ${m.text}`);
		lines.push("");
	}
	lines.push(`${dim("inbox peeks without marking read — the agent's peers_inbox marks messages read")}`);
	return lines.join("\n");
}
