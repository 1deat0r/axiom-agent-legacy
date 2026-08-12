/**
 * Rank-based layout and box-drawing renderer for the parsed Mermaid subset.
 *
 * Layout: longest-path ranks become rows (TD) or columns (LR); node boxes are
 * placed in a grid with gutters for edge routing. v2 routing:
 *   - rank-gap lanes: horizontal (TD) / vertical (LR) runs are placed on
 *     reserved lane rows/columns inside the gutter between two ranks; gutters
 *     grow when more lanes are needed than rows/columns available.
 *   - outside lanes: back edges and rank-skipping edges route around the
 *     diagram via columns (TD) or rows (LR) beyond every box, entering the
 *     target's side with the arrowhead ON the box edge — never through a box.
 *   - labels ride on their edge's line (inline, replacing the middle of a
 *     run) or sit beside a vertical run, and never overwrite box borders.
 *
 * Every grid cell carries a role so the caller can theme lines (border -> dim,
 * edge -> accent, title -> dim+bold) without re-parsing the art.
 */

import type { MermaidGraph, MermaidNode, MermaidSubgraph } from "./parser.js";

export type ArtRole = "border" | "edge" | "node" | "label" | "title" | "text";

export interface MermaidArtResult {
	lines: string[];
	roles: ArtRole[];
	width: number;
	warnings: string[];
}

export interface MermaidArtOptions {
	/** Hard cap on art width in cells; wider layouts return null. */
	maxWidth?: number;
}

interface PlacedBox {
	node: MermaidNode;
	col: number; // position within rank
	row: number; // rank index
	x0: number;
	y0: number;
	width: number;
	height: number;
}

const ROW_GAP = 3;
const COL_GAP = 3;

function boxSize(node: MermaidNode): { width: number; height: number } {
	const textWidth = Math.max(...node.text.map((line) => line.length), 1);
	return { width: textWidth + 4, height: node.text.length + 2 };
}

interface RankLayout {
	ranks: Map<string, number>;
	rankOrder: string[][]; // node ids per rank (filtered to non-empty)
}

function computeRanks(graph: MermaidGraph): RankLayout {
	const ranks = new Map<string, number>();
	for (const id of graph.nodes.keys()) ranks.set(id, 0);
	// longest-path layering; iterate until stable (cycle-safe via node-count cap)
	for (let pass = 0; pass < graph.nodes.size; pass++) {
		let changed = false;
		for (const edge of graph.edges) {
			const from = ranks.get(edge.from) ?? 0;
			const to = ranks.get(edge.to) ?? 0;
			if (to < from + 1) {
				ranks.set(edge.to, from + 1);
				changed = true;
			}
		}
		if (!changed) break;
	}
	const rankOrder: string[][] = [];
	for (const [id] of graph.nodes) {
		const rank = ranks.get(id) ?? 0;
		if (rankOrder[rank] === undefined) rankOrder[rank] = [];
		rankOrder[rank]!.push(id);
	}
	return { ranks, rankOrder: rankOrder.filter(Boolean) };
}

type Dir = "up" | "down" | "left" | "right";

/** Box-drawing corner glyph for a turn between two directions. */
function cornerGlyph(fromDir: Dir, toDir: Dir, thick: boolean): string {
	if (thick) {
		if ((fromDir === "up" && toDir === "right") || (fromDir === "right" && toDir === "up")) return "╚";
		if ((fromDir === "down" && toDir === "right") || (fromDir === "right" && toDir === "down")) return "╔";
		if ((fromDir === "down" && toDir === "left") || (fromDir === "left" && toDir === "down")) return "╗";
		return "╝";
	}
	if ((fromDir === "up" && toDir === "right") || (fromDir === "right" && toDir === "up")) return "└";
	if ((fromDir === "down" && toDir === "right") || (fromDir === "right" && toDir === "down")) return "┌";
	if ((fromDir === "down" && toDir === "left") || (fromDir === "left" && toDir === "down")) return "┐";
	return "┘";
}

/**
 * Growable character grid. Negative coordinates grow the grid leftward; all
 * rows are kept the same width so the final join is rectangular. Per-cell
 * roles power per-line theming.
 */
class Scribble {
	private grid: string[][] = [[]];
	private roles: ArtRole[][] = [[]];
	private painters: Array<Array<number | null>> = [[]];
	private offsetX = 0;

	width(): number {
		return this.grid[0]?.length ?? 0;
	}

	private ensure(x: number, y: number): void {
		while (y >= this.grid.length) {
			this.grid.push(new Array<string>(this.width()).fill(" "));
			this.roles.push(new Array<ArtRole>(this.width()).fill("text"));
			this.painters.push(new Array<number | null>(this.width()).fill(null));
		}
		while (x + this.offsetX < 0) {
			this.offsetX++;
			for (const row of this.grid) row.unshift(" ");
			for (const r of this.roles) r.unshift("text");
			for (const p of this.painters) p.unshift(null);
		}
		while (x + this.offsetX >= this.width()) {
			for (const row of this.grid) row.push(" ");
			for (const r of this.roles) r.push("text");
			for (const p of this.painters) p.push(null);
		}
	}

	peek(x: number, y: number): string {
		if (y < 0 || y >= this.grid.length) return " ";
		const gx = x + this.offsetX;
		if (gx < 0 || gx >= (this.grid[y]?.length ?? 0)) return " ";
		return this.grid[y]![gx] ?? " ";
	}

	set(
		x: number,
		y: number,
		ch: string,
		role: ArtRole,
		overwrite = false,
		painter: number | null = null,
		junctionHint?: string,
	): void {
		this.ensure(x, y);
		const gx = x + this.offsetX;
		const cur = this.grid[y]![gx] ?? " ";
		if (overwrite || cur === " ") {
			const foreign = cur !== " " && painter !== null && this.painters[y]![gx] !== painter;
			if (foreign) {
				// A corner or arrow landing on ANOTHER edge's line glyph
				// becomes a T-junction so both routes stay readable. (A glyph
				// on its own route's line simply replaces it.)
				const junction = junctionHint !== undefined ? junctionHint : JUNCTIONS[cur + ch];
				if (junction !== undefined) {
					this.grid[y]![gx] = junction;
					this.roles[y]![gx] = role;
					return;
				}
			}
			this.grid[y]![gx] = ch;
			this.roles[y]![gx] = role;
			if (painter !== null) this.painters[y]![gx] = painter;
			return;
		}
		// Perpendicular line crossing: replace the two line glyphs with a
		// crossing glyph so overlapping routes read as an intersection.
		// The painter stays with the first line: a later corner landing here
		// still sees a foreign glyph and junction-merges.
		const crossed = CROSSINGS[cur + ch];
		if (crossed !== undefined) {
			this.grid[y]![gx] = crossed;
			this.roles[y]![gx] = role;
		}
	}

	roleAt(x: number, y: number): ArtRole {
		if (y < 0 || y >= this.roles.length) return "text";
		const gx = x + this.offsetX;
		if (gx < 0 || gx >= (this.roles[y]?.length ?? 0)) return "text";
		return this.roles[y]![gx] ?? "text";
	}

	hLine(
		x0: number,
		x1: number,
		y: number,
		ch: string,
		role: ArtRole,
		overwrite = false,
		painter: number | null = null,
	): void {
		const [lo, hi] = x0 <= x1 ? [x0, x1] : [x1, x0];
		for (let x = lo; x <= hi; x++) this.set(x, y, ch, role, overwrite, painter);
	}

	vLine(
		y0: number,
		y1: number,
		x: number,
		ch: string,
		role: ArtRole,
		overwrite = false,
		painter: number | null = null,
	): void {
		const [lo, hi] = y0 <= y1 ? [y0, y1] : [y1, y0];
		for (let y = lo; y <= hi; y++) this.set(x, y, ch, role, overwrite, painter);
	}

	putText(x: number, y: number, text: string, role: ArtRole, overwrite = false): void {
		for (let i = 0; i < text.length; i++) this.set(x + i, y, text[i]!, role, overwrite);
	}

	/** True when every cell the text would cover is currently empty. */
	textFits(x: number, y: number, text: string): boolean {
		for (let i = 0; i < text.length; i++) {
			if (this.peek(x + i, y) !== " ") return false;
		}
		return true;
	}

	lines(): string[] {
		return this.grid.map((row) => row.join(""));
	}

	lineRoles(): ArtRole[] {
		return this.roles.map((row) =>
			row.includes("node")
				? "node"
				: row.includes("label")
					? "label"
					: row.includes("edge")
						? "edge"
						: row.includes("title") // title rows share the border row; title wins
							? "title"
							: row.includes("border")
								? "border"
								: "text",
		);
	}
}

const CROSSINGS: Record<string, string> = { "─│": "┼", "│─": "┼", "═║": "╪", "║═": "╪", "╌╎": "╬", "╎╌": "╬" };

/** Fallback junction pairs (e.g. arrowheads never junction; replace). */
const JUNCTIONS: Record<string, string> = {};

/** Glyphs labels must not overwrite (structural route markers). */
const EDGE_STRUCTURAL = new Set([
	"┌",
	"┐",
	"└",
	"┘",
	"╔",
	"╗",
	"╚",
	"╝",
	"├",
	"┤",
	"┬",
	"┴",
	"┼",
	"╠",
	"╣",
	"╦",
	"╩",
	"╪",
	"╬",
	"▼",
	"▲",
	"▶",
	"◀",
]);

/**
 * Junction glyph for a corner overwriting ANOTHER edge's line. Derived from
 * the corner's actual travel directions (the glyph alone is ambiguous about
 * which way the vertical arrives from).
 */
function junctionForCorner(cur: string, fromDir: Dir, toDir: Dir, thick: boolean): string | undefined {
	const vert = fromDir === "up" || fromDir === "down" ? fromDir : toDir;
	const horiz = fromDir === "left" || fromDir === "right" ? fromDir : toDir;
	const curH = cur === "─" || cur === "═" || cur === "╌";
	const curV = cur === "│" || cur === "║" || cur === "╎";
	if (curH) {
		if (cur === "═" || thick) return vert === "up" ? "╩" : "╦";
		return vert === "up" ? "┴" : "┬";
	}
	if (curV) {
		if (cur === "║" || thick) return horiz === "right" ? "╠" : "╣";
		return horiz === "right" ? "├" : "┤";
	}
	// Already a crossing glyph: the union is the crossing itself.
	if (cur === "┼" || cur === "╪" || cur === "╬") return cur;
	return undefined;
}

/** A planned drawing step; coordinates are final (post-growth) grid space. */
type Seg =
	| { kind: "h"; x0: number; x1: number; y: number }
	| { kind: "v"; y0: number; y1: number; x: number }
	| { kind: "corner"; x: number; y: number; fromDir: Dir; toDir: Dir }
	| { kind: "arrow"; x: number; y: number; ch: string };

/** Where an edge's label goes: inline on a horizontal run or beside a vertical run. */
type LabelPlan =
	| { mode: "inline"; x0: number; x1: number; y: number; text: string }
	| { mode: "beside"; x: number; y: number; text: string };

interface PlannedEdge {
	segs: Seg[];
	label?: LabelPlan;
	chars: { h: string; v: string; thick: boolean };
}

export function renderMermaidArt(graph: MermaidGraph, options: MermaidArtOptions = {}): MermaidArtResult | null {
	const { direction } = graph;
	const { rankOrder } = computeRanks(graph);
	if (rankOrder.length === 0 || graph.nodes.size === 0) return null;

	const boxes = new Map<string, PlacedBox>();
	const maxRankSize = Math.max(...rankOrder.map((rank) => rank.length));
	const widthByPos: number[] = [];
	const heightByPos: number[] = [];
	const widthByRank: number[] = [];
	const heightByRank: number[] = [];
	const rankIndex = new Map<string, number>();
	rankOrder.forEach((rank, r) => {
		for (const id of rank) rankIndex.set(id, r);
	});
	const positionInRank = new Map<string, number>();
	rankOrder.forEach((rank) => {
		rank.forEach((id, p) => {
			positionInRank.set(id, p);
		});
	});

	for (const [r, rank] of rankOrder.entries()) {
		for (const [p, id] of rank.entries()) {
			const node = graph.nodes.get(id);
			if (!node) continue;
			const { width, height } = boxSize(node);
			widthByPos[p] = Math.max(widthByPos[p] ?? 0, width);
			heightByPos[p] = Math.max(heightByPos[p] ?? 0, height);
			widthByRank[r] = Math.max(widthByRank[r] ?? 0, width);
			heightByRank[r] = Math.max(heightByRank[r] ?? 0, height);
			boxes.set(id, { node, col: p, row: r, x0: 0, y0: 0, width, height });
		}
	}

	// Same-column/same-rank labeled edges need horizontal room for their label.
	for (const edge of graph.edges) {
		const fromBox = boxes.get(edge.from);
		const toBox = boxes.get(edge.to);
		if (!edge.label || !fromBox || !toBox) continue;
		const extra = edge.label.length + 3;
		if (direction === "TD" && fromBox.row !== toBox.row && fromBox.col === toBox.col) {
			widthByPos[fromBox.col] = Math.max(widthByPos[fromBox.col] ?? 0, extra);
		}
		if (direction === "LR" && fromBox.row === toBox.row && fromBox.col !== toBox.col) {
			widthByRank[fromBox.row] = Math.max(widthByRank[fromBox.row] ?? 0, extra);
		}
	}

	const PAD = 1;
	const origins = (sizes: number[], gap: number): number[] => {
		const out: number[] = [];
		let acc = PAD;
		for (let i = 0; i < sizes.length; i++) {
			out[i] = acc;
			acc += (sizes[i] ?? 0) + (i < sizes.length - 1 ? gap : 0);
		}
		return out;
	};
	const posX = origins(widthByPos, COL_GAP);
	const rankX = origins(widthByRank, COL_GAP);
	const posY = origins(heightByPos, ROW_GAP);
	const rankY = origins(heightByRank, ROW_GAP);

	for (const [id, box] of boxes) {
		const r = rankIndex.get(id) ?? 0;
		const p = positionInRank.get(id) ?? 0;
		if (direction === "TD") {
			box.x0 = posX[p]!;
			box.y0 = rankY[r]!;
		} else {
			box.x0 = rankX[r]!;
			box.y0 = posY[p]!;
		}
	}

	const totalWidth =
		direction === "TD"
			? posX[maxRankSize - 1]! + (widthByPos[maxRankSize - 1] ?? 0)
			: rankX[rankOrder.length - 1]! + (widthByRank[rankOrder.length - 1] ?? 0);
	if (options.maxWidth !== undefined && totalWidth > options.maxWidth) {
		return null;
	}

	// Reserve one title row per subgraph: shift every box at/under a subgraph's
	// top edge down so the frame has room, before anything is drawn.
	for (const sub of graph.subgraphs) {
		const memberBoxes = sub.nodes.map((id) => boxes.get(id)).filter((b): b is PlacedBox => b !== undefined);
		if (memberBoxes.length === 0) continue;
		const top = Math.min(...memberBoxes.map((b) => b.y0));
		for (const b of boxes.values()) {
			if (b.y0 >= top) b.y0 += 1;
		}
	}

	// Rank extents (post title-reservation), used for gap lanes and clearance.
	const rankTop: number[] = [];
	const rankBottom: number[] = [];
	const rankLeft: number[] = [];
	const rankRight: number[] = [];
	for (const box of boxes.values()) {
		const r = box.row;
		rankTop[r] = Math.min(rankTop[r] ?? Number.POSITIVE_INFINITY, box.y0);
		rankBottom[r] = Math.max(rankBottom[r] ?? 0, box.y0 + box.height - 1);
		rankLeft[r] = Math.min(rankLeft[r] ?? Number.POSITIVE_INFINITY, box.x0);
		rankRight[r] = Math.max(rankRight[r] ?? 0, box.x0 + box.width - 1);
	}
	let maxRightAll = Math.max(...rankRight);
	let minLeftAll = Math.min(...rankLeft);
	let maxBottomAll = Math.max(...rankBottom);

	// --- routing plan -------------------------------------------------------
	// Phase 1: decide each edge's route shape and record the gutters it needs
	// lanes in, so gutters can grow before lane rows/columns are handed out.
	const lanesNeeded: number[] = []; // per gutter index (0..R-2)
	const bump = (g: number, n = 1) => {
		lanesNeeded[g] = (lanesNeeded[g] ?? 0) + n;
	};

	for (const edge of graph.edges) {
		const from = boxes.get(edge.from);
		const to = boxes.get(edge.to);
		if (!from || !to) continue;
		if (to.row === from.row) continue; // same-rank routes use no gutters
		if (direction === "TD") {
			if (to.row > from.row) {
				bump(from.row);
				if (to.row > from.row + 1) bump(to.row - 1);
			} else {
				bump(from.row);
				const toMid = to.y0 + Math.floor(to.height / 2);
				const rightBlocked = sideBlocked(to, "right", toMid, boxes);
				const leftBlocked = sideBlocked(to, "left", toMid, boxes);
				if (rightBlocked && leftBlocked) bump(to.row);
			}
		} else {
			if (to.row > from.row) {
				bump(from.row);
				if (to.row > from.row + 1) bump(to.row - 1);
			} else {
				bump(from.row);
			}
		}
	}

	// Phase 2: grow gutters that need more lanes than they have rows/columns.
	if (direction === "TD") {
		for (let g = 0; g < rankOrder.length - 1; g++) {
			const available = rankTop[g + 1]! - rankBottom[g]! - 1;
			const shortage = (lanesNeeded[g] ?? 0) - available;
			if (shortage > 0) {
				for (const box of boxes.values()) {
					if (box.row > g) box.y0 += shortage;
				}
			}
		}
	} else {
		for (let g = 0; g < rankOrder.length - 1; g++) {
			const available = rankLeft[g + 1]! - rankRight[g]! - 1;
			const shortage = (lanesNeeded[g] ?? 0) - available;
			if (shortage > 0) {
				for (const box of boxes.values()) {
					if (box.row > g) box.x0 += shortage;
				}
			}
		}
	}

	// Recompute extents after growth.
	for (let r = 0; r < rankOrder.length; r++) {
		rankTop[r] = Number.POSITIVE_INFINITY;
		rankBottom[r] = 0;
		rankLeft[r] = Number.POSITIVE_INFINITY;
		rankRight[r] = 0;
	}
	for (const box of boxes.values()) {
		const r = box.row;
		rankTop[r] = Math.min(rankTop[r]!, box.y0);
		rankBottom[r] = Math.max(rankBottom[r]!, box.y0 + box.height - 1);
		rankLeft[r] = Math.min(rankLeft[r]!, box.x0);
		rankRight[r] = Math.max(rankRight[r]!, box.x0 + box.width - 1);
	}
	maxRightAll = Math.max(...rankRight);
	minLeftAll = Math.min(...rankLeft);
	maxBottomAll = Math.max(...rankBottom);

	// Phase 3: hand out lane rows/columns and outside lanes, build segments.
	const laneUse: number[] = []; // per gutter: lanes handed out so far
	const takeLane = (g: number): number => {
		const lane = laneUse[g] ?? 0;
		laneUse[g] = lane + 1;
		return lane;
	};
	const laneRow = (g: number, lane: number): number => rankBottom[g]! + 1 + lane;
	const laneCol = (g: number, lane: number): number => rankRight[g]! + 1 + lane;
	let rightLaneIndex = 0;
	let leftLaneIndex = 0;

	const labelFor = (segs: Seg[], text: string | undefined): LabelPlan | undefined => {
		if (!text) return undefined;
		// 1. Inline on the longest horizontal run (with room for " text ").
		let best: { x0: number; x1: number; y: number } | undefined;
		for (const seg of segs) {
			if (seg.kind !== "h") continue;
			const length = Math.abs(seg.x1 - seg.x0) + 1;
			if (length >= text.length + 4 && (!best || length > Math.abs(best.x1 - best.x0) + 1)) {
				best = { x0: seg.x0, x1: seg.x1, y: seg.y };
			}
		}
		if (best) return { mode: "inline", x0: best.x0, x1: best.x1, y: best.y, text };
		// 2. Beside the first vertical run, at its midpoint.
		for (const seg of segs) {
			if (seg.kind !== "v") continue;
			const mid = Math.floor((seg.y0 + seg.y1) / 2);
			return { mode: "beside", x: seg.x, y: mid, text };
		}
		// 3. Beside the longest horizontal run (straight same-row edges have
		// no vertical run; the placement scan finds a free row nearby).
		if (best === undefined) {
			let longest: { x0: number; x1: number; y: number } | undefined;
			for (const seg of segs) {
				if (seg.kind !== "h") continue;
				const length = Math.abs(seg.x1 - seg.x0) + 1;
				if (!longest || length > Math.abs(longest.x1 - longest.x0) + 1) {
					longest = { x0: seg.x0, x1: seg.x1, y: seg.y };
				}
			}
			if (longest) {
				return { mode: "beside", x: Math.floor((longest.x0 + longest.x1) / 2), y: longest.y, text };
			}
		}
		return undefined;
	};

	const planned: PlannedEdge[] = [];

	for (const edge of graph.edges) {
		const from = boxes.get(edge.from);
		const to = boxes.get(edge.to);
		if (!from || !to) continue;
		const chars = {
			h: edge.style === "thick" ? "═" : edge.style === "dotted" ? "╌" : "─",
			v: edge.style === "thick" ? "║" : edge.style === "dotted" ? "╎" : "│",
			thick: edge.style === "thick",
		};
		const segs: Seg[] = [];

		if (direction === "TD") {
			const fromCenterX = from.x0 + Math.floor(from.width / 2);
			const toCenterX = to.x0 + Math.floor(to.width / 2);
			if (to.row === from.row) {
				// side-by-side: connect the facing sides at a shared mid row
				const fromMid = from.y0 + Math.floor(from.height / 2);
				const toMid = to.y0 + Math.floor(to.height / 2);
				if (to.x0 >= from.x0) {
					const entryX = to.x0 - 1;
					segs.push({ kind: "h", x0: from.x0 + from.width, x1: entryX, y: fromMid });
					if (fromMid !== toMid) {
						segs.push({
							kind: "corner",
							x: entryX,
							y: fromMid,
							fromDir: "left",
							toDir: toMid > fromMid ? "down" : "up",
						});
						segs.push({ kind: "v", y0: fromMid, y1: toMid, x: entryX });
					}
					if (edge.directed) segs.push({ kind: "arrow", x: entryX, y: toMid, ch: "▶" });
				} else {
					const entryX = to.x0 + to.width;
					segs.push({ kind: "h", x0: from.x0 - 1, x1: entryX, y: fromMid });
					if (fromMid !== toMid) {
						segs.push({
							kind: "corner",
							x: entryX,
							y: fromMid,
							fromDir: "right",
							toDir: toMid > fromMid ? "down" : "up",
						});
						segs.push({ kind: "v", y0: fromMid, y1: toMid, x: entryX });
					}
					if (edge.directed) segs.push({ kind: "arrow", x: entryX, y: toMid, ch: "◀" });
				}
			} else if (to.row > from.row) {
				const fromBottom = from.y0 + from.height;
				const toTop = to.y0;
				if (to.row === from.row + 1 && from.col === to.col) {
					// straight down on the target's center column
					segs.push({ kind: "v", y0: fromBottom, y1: toTop - 1, x: toCenterX });
					if (edge.directed) segs.push({ kind: "arrow", x: toCenterX, y: toTop - 1, ch: "▼" });
				} else if (to.row === from.row + 1) {
					const lane = takeLane(from.row);
					const y = laneRow(from.row, lane);
					const dir = fromCenterX < toCenterX ? "right" : "left";
					segs.push({ kind: "v", y0: fromBottom, y1: y, x: fromCenterX });
					segs.push({ kind: "corner", x: fromCenterX, y, fromDir: "down", toDir: dir });
					segs.push({ kind: "h", x0: fromCenterX, x1: toCenterX, y });
					segs.push({
						kind: "corner",
						x: toCenterX,
						y,
						fromDir: dir === "right" ? "left" : "right",
						toDir: "down",
					});
					segs.push({ kind: "v", y0: y, y1: toTop - 1, x: toCenterX });
					if (edge.directed) segs.push({ kind: "arrow", x: toCenterX, y: toTop - 1, ch: "▼" });
				} else {
					// rank-skipping: route around the right side
					const lane1 = takeLane(from.row);
					const lane2 = takeLane(to.row - 1);
					const y1 = laneRow(from.row, lane1);
					const y2 = laneRow(to.row - 1, lane2);
					const outsideX = maxRightAll + 2 + rightLaneIndex * 2;
					rightLaneIndex++;
					segs.push({ kind: "v", y0: fromBottom, y1: y1, x: fromCenterX });
					segs.push({ kind: "corner", x: fromCenterX, y: y1, fromDir: "down", toDir: "right" });
					segs.push({ kind: "h", x0: fromCenterX, x1: outsideX, y: y1 });
					segs.push({ kind: "corner", x: outsideX, y: y1, fromDir: "right", toDir: "down" });
					segs.push({ kind: "v", y0: y1 + 1, y1: y2, x: outsideX });
					segs.push({ kind: "corner", x: outsideX, y: y2, fromDir: "down", toDir: "left" });
					segs.push({ kind: "h", x0: outsideX, x1: toCenterX, y: y2 });
					segs.push({ kind: "corner", x: toCenterX, y: y2, fromDir: "left", toDir: "down" });
					segs.push({ kind: "v", y0: y2 + 1, y1: toTop - 1, x: toCenterX });
					if (edge.directed) segs.push({ kind: "arrow", x: toCenterX, y: toTop - 1, ch: "▼" });
				}
			} else {
				// upward/back edge: exit below the source, route outside, enter
				// the target's side (or bottom when both sides are blocked).
				const fromBottom = from.y0 + from.height;
				const toMid = to.y0 + Math.floor(to.height / 2);
				const lane = takeLane(from.row);
				const yExit = laneRow(from.row, lane);
				const rightBlocked = sideBlocked(to, "right", toMid, boxes);
				const leftBlocked = sideBlocked(to, "left", toMid, boxes);
				if (!rightBlocked || !leftBlocked) {
					const useRight = !rightBlocked;
					const outsideX = useRight ? maxRightAll + 2 + rightLaneIndex * 2 : minLeftAll - 3 - leftLaneIndex * 3;
					if (useRight) rightLaneIndex++;
					else leftLaneIndex++;
					const exitDir = useRight ? "right" : "left";
					segs.push({ kind: "v", y0: fromBottom, y1: yExit, x: fromCenterX });
					segs.push({ kind: "corner", x: fromCenterX, y: yExit, fromDir: "down", toDir: exitDir });
					segs.push({ kind: "h", x0: fromCenterX, x1: outsideX, y: yExit });
					segs.push({ kind: "corner", x: outsideX, y: yExit, fromDir: exitDir, toDir: "up" });
					segs.push({ kind: "v", y0: toMid, y1: yExit - 1, x: outsideX });
					segs.push({ kind: "corner", x: outsideX, y: toMid, fromDir: "up", toDir: exitDir });
					if (useRight) {
						segs.push({ kind: "h", x0: to.x0 + to.width, x1: outsideX, y: toMid });
						if (edge.directed) segs.push({ kind: "arrow", x: to.x0 + to.width, y: toMid, ch: "◀" });
					} else {
						segs.push({ kind: "h", x0: outsideX, x1: to.x0 - 1, y: toMid });
						if (edge.directed) segs.push({ kind: "arrow", x: to.x0 - 1, y: toMid, ch: "▶" });
					}
				} else {
					// both sides blocked: enter from the bottom
					const laneEntry = takeLane(to.row);
					const yEntry = laneRow(to.row, laneEntry);
					const outsideX = maxRightAll + 2 + rightLaneIndex * 2;
					rightLaneIndex++;
					const toBottom = to.y0 + to.height;
					segs.push({ kind: "v", y0: fromBottom, y1: yExit, x: fromCenterX });
					segs.push({ kind: "corner", x: fromCenterX, y: yExit, fromDir: "down", toDir: "right" });
					segs.push({ kind: "h", x0: fromCenterX, x1: outsideX, y: yExit });
					segs.push({ kind: "corner", x: outsideX, y: yExit, fromDir: "right", toDir: "up" });
					segs.push({ kind: "v", y0: yEntry, y1: yExit - 1, x: outsideX });
					segs.push({ kind: "corner", x: outsideX, y: yEntry, fromDir: "up", toDir: "left" });
					segs.push({ kind: "h", x0: toCenterX, x1: outsideX, y: yEntry });
					segs.push({ kind: "corner", x: toCenterX, y: yEntry, fromDir: "left", toDir: "up" });
					segs.push({ kind: "v", y0: toBottom + 2, y1: yEntry - 1, x: toCenterX });
					if (edge.directed) segs.push({ kind: "arrow", x: toCenterX, y: toBottom + 1, ch: "▲" });
				}
			}
		} else {
			// LR: ranks run horizontally (columns); gutters are vertical lanes.
			const fromCenterY = from.y0 + Math.floor(from.height / 2);
			const toCenterY = to.y0 + Math.floor(to.height / 2);
			if (to.row === from.row) {
				// stacked in the same rank: vertical connection
				if (to.y0 >= from.y0) {
					const fromBottom = from.y0 + from.height;
					const targetX = to.x0 + Math.floor(to.width / 2);
					segs.push({ kind: "v", y0: fromBottom, y1: to.y0 - 1, x: targetX });
					if (edge.directed) segs.push({ kind: "arrow", x: targetX, y: to.y0 - 1, ch: "▼" });
				} else {
					const toBottom = to.y0 + to.height;
					const targetX = to.x0 + Math.floor(to.width / 2);
					segs.push({ kind: "v", y0: toBottom + 1, y1: from.y0 - 1, x: targetX });
					if (edge.directed) segs.push({ kind: "arrow", x: targetX, y: toBottom + 1, ch: "▲" });
				}
			} else if (to.row > from.row) {
				const fromRight = from.x0 + from.width;
				const toLeft = to.x0;
				if (to.row === from.row + 1 && from.col === to.col) {
					segs.push({ kind: "h", x0: fromRight, x1: toLeft - 1, y: fromCenterY });
					if (edge.directed) segs.push({ kind: "arrow", x: toLeft - 1, y: fromCenterY, ch: "▶" });
				} else if (to.row === from.row + 1) {
					const lane = takeLane(from.row);
					const x = laneCol(from.row, lane);
					const goDown = toCenterY >= fromCenterY;
					segs.push({ kind: "h", x0: fromRight, x1: x, y: fromCenterY });
					segs.push({ kind: "corner", x, y: fromCenterY, fromDir: "right", toDir: goDown ? "down" : "up" });
					segs.push({ kind: "v", y0: fromCenterY, y1: toCenterY, x });
					segs.push({ kind: "corner", x, y: toCenterY, fromDir: goDown ? "down" : "up", toDir: "right" });
					segs.push({ kind: "h", x0: x, x1: toLeft - 1, y: toCenterY });
					if (edge.directed) segs.push({ kind: "arrow", x: toLeft - 1, y: toCenterY, ch: "▶" });
				} else {
					// rank-skipping: route below the diagram
					const lane1 = takeLane(from.row);
					const lane2 = takeLane(to.row - 1);
					const x1 = laneCol(from.row, lane1);
					const x2 = laneCol(to.row - 1, lane2);
					const outY = maxBottomAll + 2 + rightLaneIndex * 2;
					rightLaneIndex++;
					segs.push({ kind: "h", x0: fromRight, x1: x1, y: fromCenterY });
					segs.push({ kind: "corner", x: x1, y: fromCenterY, fromDir: "right", toDir: "down" });
					segs.push({ kind: "v", y0: fromCenterY + 1, y1: outY, x: x1 });
					segs.push({ kind: "corner", x: x1, y: outY, fromDir: "down", toDir: x2 < x1 ? "left" : "right" });
					segs.push({ kind: "h", x0: x1, x1: x2, y: outY });
					segs.push({ kind: "corner", x: x2, y: outY, fromDir: x2 < x1 ? "left" : "right", toDir: "up" });
					segs.push({ kind: "v", y0: toCenterY, y1: outY - 1, x: x2 });
					segs.push({ kind: "corner", x: x2, y: toCenterY, fromDir: "up", toDir: "left" });
					segs.push({ kind: "h", x0: toLeft - 1, x1: x2, y: toCenterY });
					if (edge.directed) segs.push({ kind: "arrow", x: toLeft - 1, y: toCenterY, ch: "▶" });
				}
			} else {
				// back edge: route below the diagram, enter from the left
				const fromRight = from.x0 + from.width;
				const toLeft = to.x0;
				const lane = takeLane(from.row);
				const xExit = laneCol(from.row, lane);
				const outY = maxBottomAll + 2 + rightLaneIndex * 2;
				rightLaneIndex++;
				const xEntry = minLeftAll - 3 - leftLaneIndex * 3;
				leftLaneIndex++;
				segs.push({ kind: "h", x0: fromRight, x1: xExit, y: fromCenterY });
				segs.push({ kind: "corner", x: xExit, y: fromCenterY, fromDir: "right", toDir: "down" });
				segs.push({ kind: "v", y0: fromCenterY + 1, y1: outY, x: xExit });
				segs.push({ kind: "corner", x: xExit, y: outY, fromDir: "down", toDir: "left" });
				segs.push({ kind: "h", x0: xEntry, x1: xExit, y: outY });
				segs.push({ kind: "corner", x: xEntry, y: outY, fromDir: "left", toDir: "up" });
				segs.push({ kind: "v", y0: toCenterY, y1: outY - 1, x: xEntry });
				segs.push({ kind: "corner", x: xEntry, y: toCenterY, fromDir: "up", toDir: "right" });
				segs.push({ kind: "h", x0: xEntry, x1: toLeft - 1, y: toCenterY });
				if (edge.directed) segs.push({ kind: "arrow", x: toLeft - 1, y: toCenterY, ch: "▶" });
			}
		}

		planned.push({ segs, label: labelFor(segs, edge.label), chars });
	}

	// --- draw ---------------------------------------------------------------
	const s = new Scribble();

	// node boxes first
	for (const box of boxes.values()) {
		drawBox(box, s);
	}

	// then edges
	let edgeIndex = 0;
	for (const { segs, label, chars } of planned) {
		drawSegs(segs, chars, s, edgeIndex++);
		placeLabel(label, s);
	}

	// subgraph frames last (top-down so row insertions stay ordered)
	const sorted = [...graph.subgraphs].sort((a, b) => subgraphTop(a, boxes) - subgraphTop(b, boxes));
	for (const sub of sorted) {
		drawSubgraphFrame(sub, boxes, s);
	}

	const lines = s.lines();
	const finalWidth = s.width();
	if (options.maxWidth !== undefined && finalWidth > options.maxWidth) {
		return null;
	}
	return { lines, roles: s.lineRoles(), width: finalWidth, warnings: graph.warnings };
}

function drawSegs(segs: Seg[], chars: { h: string; v: string; thick: boolean }, s: Scribble, painter: number): void {
	for (const seg of segs) {
		switch (seg.kind) {
			case "h":
				s.hLine(seg.x0, seg.x1, seg.y, chars.h, "edge", false, painter);
				break;
			case "v":
				s.vLine(seg.y0, seg.y1, seg.x, chars.v, "edge", false, painter);
				break;
			case "corner": {
				const glyph = cornerGlyph(seg.fromDir, seg.toDir, chars.thick);
				const hint = junctionForCorner(s.peek(seg.x, seg.y), seg.fromDir, seg.toDir, chars.thick);
				s.set(seg.x, seg.y, glyph, "edge", true, painter, hint);
				break;
			}
			case "arrow":
				s.set(seg.x, seg.y, seg.ch, "edge", true, painter);
				break;
		}
	}
}

function placeLabel(label: LabelPlan | undefined, s: Scribble): void {
	if (!label) return;
	if (label.mode === "inline") {
		const [lo, hi] = label.x0 <= label.x1 ? [label.x0, label.x1] : [label.x1, label.x0];
		const decorated = ` ${label.text} `;
		const start = lo + Math.floor((hi - lo + 1 - decorated.length) / 2);
		s.putText(start, label.y, decorated, "label", true);
		return;
	}
	// Beside a vertical run. Labels may sit on other edges' plain line cells
	// (they are drawn after all edges and overwrite), but never on box
	// borders/text, other labels, or structural glyphs (corners, junctions,
	// arrowheads). Scan outward, then the rows above/below, when blocked.
	const blocked = (x: number, y: number): boolean => {
		// one-cell clearance around the label from structural route markers
		if (EDGE_STRUCTURAL.has(s.peek(x - 1, y)) || EDGE_STRUCTURAL.has(s.peek(x + label.text.length, y))) {
			return true;
		}
		for (let i = 0; i < label.text.length; i++) {
			const r = s.roleAt(x + i, y);
			if (r === "border" || r === "node" || r === "label" || r === "title") return true;
			const ch = s.peek(x + i, y);
			if (EDGE_STRUCTURAL.has(ch)) return true;
		}
		return false;
	};
	const placeAt = (x: number, y: number): boolean => {
		if (blocked(x, y)) return false;
		s.putText(x, y, label.text, "label", true);
		return true;
	};
	for (const y of [label.y, label.y + 1, label.y - 1, label.y + 2, label.y - 2]) {
		for (let x = label.x + 2; x <= label.x + 10; x++) {
			if (placeAt(x, y)) return;
		}
	}
	for (let x = label.x + 2; x <= label.x + 2 + 60; x++) {
		if (placeAt(x, label.y)) return;
	}
	for (let x = label.x - 2 - label.text.length; x >= label.x - 2 - label.text.length - 60; x--) {
		if (placeAt(x, label.y)) return;
	}
}

function sideBlocked(box: PlacedBox, side: "left" | "right", entryRow: number, boxes: Map<string, PlacedBox>): boolean {
	for (const b of boxes.values()) {
		if (b === box || b.row !== box.row) continue;
		if (side === "right" && b.x0 <= box.x0) continue;
		if (side === "left" && b.x0 >= box.x0) continue;
		if (b.y0 <= entryRow && entryRow < b.y0 + b.height) return true;
	}
	return false;
}

function drawBox(box: PlacedBox, s: Scribble): void {
	const { x0, y0, width: w, height: h } = box;
	const { shape } = box.node;
	const textLines = box.node.text;
	const set = (x: number, y: number, ch: string, r: ArtRole) => s.set(x, y, ch, r);
	if (shape === "circle") {
		set(x0, y0, "(", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, ")", "border");
		set(x0, y0 + h - 1, "(", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, ")", "border");
	} else if (shape === "rounded" || shape === "stadium") {
		set(x0, y0, "╭", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "╮", "border");
		set(x0, y0 + h - 1, "╰", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "╯", "border");
	} else if (shape === "diamond") {
		set(x0, y0, "╭", "border");
		s.hLine(x0 + 1, Math.floor(x0 + w / 2) - 1, y0, "─", "border");
		set(Math.floor(x0 + w / 2), y0, "┬", "border");
		s.hLine(Math.floor(x0 + w / 2) + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "╮", "border");
		set(x0, y0 + h - 1, "╰", "border");
		s.hLine(x0 + 1, Math.floor(x0 + w / 2) - 1, y0 + h - 1, "─", "border");
		set(Math.floor(x0 + w / 2), y0 + h - 1, "┴", "border");
		s.hLine(Math.floor(x0 + w / 2) + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "╯", "border");
	} else {
		set(x0, y0, "┌", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "┐", "border");
		set(x0, y0 + h - 1, "└", "border");
		s.hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "┘", "border");
	}
	for (let i = 0; i < h - 2; i++) {
		const line = textLines[i] ?? "";
		const pad = Math.floor((w - 2 - line.length) / 2);
		set(x0, y0 + 1 + i, "│", "border");
		s.putText(x0 + 1 + pad, y0 + 1 + i, line, "node");
		set(x0 + w - 1, y0 + 1 + i, "│", "border");
	}
}

function subgraphTop(sub: MermaidSubgraph, boxes: Map<string, PlacedBox>): number {
	let top = Number.POSITIVE_INFINITY;
	for (const id of sub.nodes) {
		const box = boxes.get(id);
		if (box && box.y0 < top) top = box.y0;
	}
	return top === Number.POSITIVE_INFINITY ? 0 : top;
}

function drawSubgraphFrame(sub: MermaidSubgraph, boxes: Map<string, PlacedBox>, s: Scribble): void {
	const members = sub.nodes.map((id) => boxes.get(id)).filter((b): b is PlacedBox => b !== undefined);
	if (members.length === 0) return;
	const minX = Math.min(...members.map((b) => b.x0)) - 1;
	let maxX = Math.max(...members.map((b) => b.x0 + b.width)) + 1;
	const minY = Math.min(...members.map((b) => b.y0)) - 1;
	const maxY = Math.max(...members.map((b) => b.y0 + b.height)) + 1;

	// The frame must be wide enough to carry its own title, else a title
	// longer than the member boxes gets clipped. Widen the frame to fit: the
	// title sits flush under the top-left corner, dashes fill to the corner.
	const title = sub.title || sub.id;
	const titleText = ` ${title}`;
	maxX = Math.max(maxX, minX + titleText.length + 1);

	const topY = minY - 1;
	s.set(minX, topY, "┌", "border", true);
	s.putText(minX + 1, topY, titleText, "title", true);
	// Dash-fill only when there is a real gap between the title and the corner.
	if (minX + 1 + titleText.length <= maxX - 1) {
		s.hLine(minX + 1 + titleText.length, maxX - 1, topY, "─", "border");
	}
	s.set(maxX, topY, "┐", "border", true);
	for (let y = topY + 1; y <= maxY; y++) {
		s.set(minX, y, "│", "border");
		s.set(maxX, y, "│", "border");
	}
	s.set(minX, maxY + 1, "└", "border", true);
	s.hLine(minX + 1, maxX - 1, maxY + 1, "─", "border");
	s.set(maxX, maxY + 1, "┘", "border", true);
}
