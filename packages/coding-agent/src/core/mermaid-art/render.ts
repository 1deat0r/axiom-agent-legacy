/**
 * Rank-based layout and box-drawing renderer for the parsed Mermaid subset.
 *
 * Layout: longest-path ranks become rows (TD) or columns (LR); node boxes are
 * placed in a grid with gutters for edge routing; edges are drawn orthogonally
 * (vertical/horizontal runs with box-drawing corners) with arrowheads, labels,
 * dotted/thick styles; subgraphs get a frame with their title on the border.
 *
 * Every grid cell carries a role so the caller can theme lines (border -> dim,
 * edge -> accent, title -> dim+bold) without re-parsing the art.
 */

import type { MermaidEdge, MermaidGraph, MermaidNode, MermaidSubgraph } from "./parser.js";

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
	row: number; // rank
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
	rankOrder: string[][]; // node ids per rank
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

export function renderMermaidArt(graph: MermaidGraph, options: MermaidArtOptions = {}): MermaidArtResult | null {
	const { direction } = graph;
	const { rankOrder } = computeRanks(graph);
	if (rankOrder.length === 0 || graph.nodes.size === 0) return null;

	const boxes = new Map<string, PlacedBox>();
	const maxRankSize = Math.max(...rankOrder.map((rank) => rank.length));
	// Width/height per position (across ranks) and per rank, so both TD and LR
	// can build origin arrays from the axis that fits.
	const widthByPos: number[] = [];
	const heightByPos: number[] = [];
	const widthByRank: number[] = [];
	const heightByRank: number[] = [];
	const rankIndex = new Map<string, number>(); // node id -> rank index
	rankOrder.forEach((rank, r) => {
		rank.forEach((id) => {
			rankIndex.set(id, r);
		});
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

	// Same-column/same-rank labeled edges need horizontal room for their label
	// (labels sit beside the vertical run).
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
	const origins = (sizes: number[]): number[] => {
		const out: number[] = [];
		let acc = PAD;
		for (let i = 0; i < sizes.length; i++) {
			out[i] = acc;
			acc +=
				(sizes[i] ?? 0) +
				(i < sizes.length - 1 ? (sizes === widthByPos || sizes === widthByRank ? COL_GAP : ROW_GAP) : 0);
		}
		return out;
	};
	const posX = origins(widthByPos);
	const rankX = origins(widthByRank);
	const posY = origins(heightByPos);
	const rankY = origins(heightByRank);

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
	const totalHeight =
		direction === "TD"
			? rankY[rankOrder.length - 1]! + (heightByRank[rankOrder.length - 1] ?? 0)
			: posY[maxRankSize - 1]! + (heightByPos[maxRankSize - 1] ?? 0);
	if (options.maxWidth !== undefined && totalWidth > options.maxWidth) {
		return null;
	}

	// TD: y = rank axis, x = position axis. LR: x = rank axis, y = position axis.
	const grid: string[][] = [];
	const roles: ArtRole[][] = [];
	for (let y = 0; y < totalHeight; y++) {
		grid[y] = new Array<string>(totalWidth).fill(" ");
		roles[y] = new Array<ArtRole>(totalWidth).fill("text");
	}

	const set = (x: number, y: number, ch: string, role: ArtRole, overwrite = false) => {
		if (x < 0 || y < 0 || y >= grid.length || x >= (grid[0]?.length ?? 0)) return;
		if (overwrite || grid[y]![x] === " ") {
			grid[y]![x] = ch;
			roles[y]![x] = role;
		}
	};

	const hLine = (x0: number, x1: number, y: number, ch: string, role: ArtRole) => {
		const [lo, hi] = x0 <= x1 ? [x0, x1] : [x1, x0];
		for (let x = lo; x <= hi; x++) set(x, y, ch, role);
	};
	const vLine = (y0: number, y1: number, x: number, ch: string, role: ArtRole) => {
		const [lo, hi] = y0 <= y1 ? [y0, y1] : [y1, y0];
		for (let y = lo; y <= hi; y++) set(x, y, ch, role);
	};
	const putText = (x: number, y: number, text: string, role: ArtRole, overwrite = false) => {
		for (let i = 0; i < text.length; i++) set(x + i, y, text[i]!, role, overwrite);
	};

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

	// --- draw node boxes ---
	for (const box of boxes.values()) {
		drawBox(box, set, hLine, putText);
	}

	// --- draw edges ---
	for (const edge of graph.edges) {
		drawEdge(edge, boxes, direction, set, hLine, vLine, putText);
	}

	// --- subgraph frames (top-down so row insertions stay ordered) ---
	const sorted = [...graph.subgraphs].sort((a, b) => subgraphTop(a, boxes) - subgraphTop(b, boxes));
	for (const sub of sorted) {
		drawSubgraphFrame(sub, boxes, grid, roles, set, hLine, putText);
	}

	const lines = grid.map((row) => row.join(""));
	const roleLines = roles.map((row) =>
		row.includes("node")
			? "node"
			: row.includes("label")
				? "label"
				: row.includes("edge")
					? "edge"
					: row.includes("border")
						? "border"
						: row.includes("title")
							? "title"
							: "text",
	);
	return { lines, roles: roleLines, width: totalWidth, warnings: graph.warnings };
}

function drawBox(
	box: PlacedBox,
	set: (x: number, y: number, ch: string, role: ArtRole, overwrite?: boolean) => void,
	hLine: (x0: number, x1: number, y: number, ch: string, role: ArtRole) => void,
	putText: (x: number, y: number, text: string, role: ArtRole, overwrite?: boolean) => void,
): void {
	const { x0, y0, width: w, height: h } = box;
	const { shape } = box.node;
	const textLines = box.node.text;
	if (shape === "circle") {
		set(x0, y0, "(", "border");
		hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, ")", "border");
		set(x0, y0 + h - 1, "(", "border");
		hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, ")", "border");
	} else if (shape === "rounded" || shape === "stadium") {
		set(x0, y0, "╭", "border");
		hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "╮", "border");
		set(x0, y0 + h - 1, "╰", "border");
		hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "╯", "border");
	} else if (shape === "diamond") {
		set(x0, y0, "╭", "border");
		hLine(x0 + 1, Math.floor(x0 + w / 2) - 1, y0, "─", "border");
		set(Math.floor(x0 + w / 2), y0, "┬", "border");
		hLine(Math.floor(x0 + w / 2) + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "╮", "border");
		set(x0, y0 + h - 1, "╰", "border");
		hLine(x0 + 1, Math.floor(x0 + w / 2) - 1, y0 + h - 1, "─", "border");
		set(Math.floor(x0 + w / 2), y0 + h - 1, "┴", "border");
		hLine(Math.floor(x0 + w / 2) + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "╯", "border");
	} else {
		set(x0, y0, "┌", "border");
		hLine(x0 + 1, x0 + w - 2, y0, "─", "border");
		set(x0 + w - 1, y0, "┐", "border");
		set(x0, y0 + h - 1, "└", "border");
		hLine(x0 + 1, x0 + w - 2, y0 + h - 1, "─", "border");
		set(x0 + w - 1, y0 + h - 1, "┘", "border");
	}
	for (let i = 0; i < h - 2; i++) {
		const line = textLines[i] ?? "";
		const pad = Math.floor((w - 2 - line.length) / 2);
		set(x0, y0 + 1 + i, "│", "border");
		putText(x0 + 1 + pad, y0 + 1 + i, line, "node");
		set(x0 + w - 1, y0 + 1 + i, "│", "border");
	}
}

function edgeChars(style: "solid" | "dotted" | "thick", axis: "h" | "v"): string {
	if (style === "thick") return axis === "h" ? "═" : "║";
	if (style === "dotted") return axis === "h" ? "╌" : "╎";
	return axis === "h" ? "─" : "│";
}

function drawEdge(
	edge: MermaidEdge,
	boxes: Map<string, PlacedBox>,
	direction: "TD" | "LR",
	set: (x: number, y: number, ch: string, role: ArtRole, overwrite?: boolean) => void,
	hLine: (x0: number, x1: number, y: number, ch: string, role: ArtRole) => void,
	vLine: (y0: number, y1: number, x: number, ch: string, role: ArtRole) => void,
	putText: (x: number, y: number, text: string, role: ArtRole, overwrite?: boolean) => void,
): void {
	const from = boxes.get(edge.from);
	const to = boxes.get(edge.to);
	if (!from || !to) return;
	const role: ArtRole = "edge";
	const h = edgeChars(edge.style, "h");
	const v = edgeChars(edge.style, "v");

	if (direction === "TD") {
		const sx = from.x0 + Math.floor(from.width / 2);
		const sy = from.y0 + from.height;
		const tx = to.x0 + Math.floor(to.width / 2);
		const ty = to.y0 - 1;
		if (to.row > from.row) {
			const midY = from.y0 + from.height + Math.floor(ROW_GAP / 2);
			if (from.col === to.col) {
				// Same column: draw straight down on the target's center so the
				// arrow lands on the target box top even when widths differ.
				vLine(sy + 1, ty - 1, tx, v, role);
				if (edge.directed) set(tx, ty, "▼", role, true);
			} else {
				vLine(sy + 1, midY - 1, sx, v, role);
				set(sx, midY, sx < tx ? "└" : "┘", role, true);
				hLine(sx, tx, midY, h, role);
				set(tx, midY, sx < tx ? "┐" : "┌", role, true);
				vLine(midY + 1, ty - 1, tx, v, role);
				if (edge.directed) set(tx, ty, "▼", role, true);
			}
			if (edge.label) {
				if (sx === tx) {
					putText(sx + 1, midY, edge.label, "label", true);
				} else {
					const labelX = Math.min(sx, tx) + Math.floor(Math.abs(tx - sx) / 2) - Math.floor(edge.label.length / 2);
					putText(labelX, midY, edge.label, "label", true);
				}
			}
		} else if (to.row === from.row) {
			// same rank: connect sides
			const my = from.y0 + Math.floor(from.height / 2);
			if (to.x0 >= from.x0) {
				hLine(from.x0 + from.width, to.x0 - 1, my, h, role);
				if (edge.directed) set(to.x0 - 1, my, "▶", role, true);
			} else {
				hLine(to.x0 + to.width, from.x0 - 1, my, h, role);
				if (edge.directed) set(from.x0 - 1, my, "◀", role, true);
			}
			if (edge.label)
				putText(
					Math.min(from.x0, to.x0) + Math.floor(Math.abs(to.x0 - from.x0) / 2) - Math.floor(edge.label.length / 2),
					my - 1,
					edge.label,
					"label",
					true,
				);
		} else {
			// upward edge: route along the right side
			const midX = Math.max(from.x0 + from.width, to.x0 + to.width) + 1;
			const my = from.y0 + Math.floor(from.height / 2);
			hLine(from.x0 + from.width, midX, my, h, role);
			vLine(
				Math.min(my, to.y0 + Math.floor(to.height / 2)),
				Math.max(my, to.y0 + Math.floor(to.height / 2)),
				midX,
				v,
				role,
			);
			hLine(midX, to.x0 - 1, to.y0 + Math.floor(to.height / 2), h, role);
			if (edge.directed) set(to.x0 - 1, to.y0 + Math.floor(to.height / 2), "◀", role, true);
			if (edge.label) putText(midX + 1, my, edge.label, "label", true);
		}
	} else {
		// LR: ranks run horizontally, so edges advance along ranks (row).
		const sy = from.y0 + Math.floor(from.height / 2);
		const sx = from.x0 + from.width;
		const ty = to.y0 + Math.floor(to.height / 2);
		const tx = to.x0 - 1;
		if (to.row > from.row) {
			const midX = from.x0 + from.width + Math.floor(COL_GAP / 2);
			if (sy === ty) {
				hLine(sx + 1, tx - 1, sy, h, role);
				if (edge.directed) set(tx, sy, "▶", role, true);
			} else {
				hLine(sx + 1, midX - 1, sy, h, role);
				set(midX, sy, sy < ty ? "┐" : "┘", role, true);
				vLine(sy, ty, midX, v, role);
				set(midX, ty, sy < ty ? "└" : "┌", role, true);
				hLine(midX + 1, tx - 1, ty, h, role);
				if (edge.directed) set(tx, ty, "▶", role, true);
			}
			if (edge.label) {
				if (sy === ty) {
					putText(sx + 2, sy - 1, edge.label, "label", true);
				} else {
					const labelX = Math.floor((sx + tx) / 2) - Math.floor(edge.label.length / 2);
					putText(labelX, Math.min(sy, ty) + Math.floor(Math.abs(ty - sy) / 2), edge.label, "label", true);
				}
			}
		} else if (to.row === from.row) {
			const mx = from.x0 + Math.floor(from.width / 2);
			if (ty >= sy) {
				vLine(sy + 1, ty - 1, mx, v, role);
				if (edge.directed) set(mx, ty, "▼", role, true);
			} else {
				vLine(ty + 1, sy - 1, mx, v, role);
				if (edge.directed) set(mx, ty, "▲", role, true);
			}
			if (edge.label) putText(mx + 1, Math.min(sy, ty), edge.label, "label", true);
		} else {
			const midY = Math.max(sy, ty) + 1;
			hLine(sx, tx, midY, h, role);
			if (edge.directed) set(tx, midY, "◀", role, true);
			if (edge.label)
				putText(
					Math.min(sx, tx) + Math.floor(Math.abs(tx - sx) / 2) - Math.floor(edge.label.length / 2),
					midY - 1,
					edge.label,
					"label",
					true,
				);
		}
	}
}

function subgraphTop(sub: MermaidSubgraph, boxes: Map<string, PlacedBox>): number {
	let top = Infinity;
	for (const id of sub.nodes) {
		const box = boxes.get(id);
		if (box && box.y0 < top) top = box.y0;
	}
	return top === Infinity ? 0 : top;
}

function drawSubgraphFrame(
	sub: MermaidSubgraph,
	boxes: Map<string, PlacedBox>,
	grid: string[][],
	roles: ArtRole[][],
	set: (x: number, y: number, ch: string, role: ArtRole, overwrite?: boolean) => void,
	hLine: (x0: number, x1: number, y: number, ch: string, role: ArtRole) => void,
	putText: (x: number, y: number, text: string, role: ArtRole, overwrite?: boolean) => void,
): void {
	const members = sub.nodes.map((id) => boxes.get(id)).filter((b): b is PlacedBox => b !== undefined);
	if (members.length === 0) return;
	const minX = Math.min(...members.map((b) => b.x0)) - 1;
	const maxX = Math.max(...members.map((b) => b.x0 + b.width)) + 1;
	const minY = Math.min(...members.map((b) => b.y0)) - 1;
	const maxY = Math.max(...members.map((b) => b.y0 + b.height)) + 1;

	const topY = minY - 1;
	// Grow the grid if the frame's bottom border would fall past it.
	const needed = maxY + 2;
	while (grid.length < needed) {
		grid.push(new Array<string>(grid[0]?.length ?? 1).fill(" "));
		roles.push(new Array<ArtRole>(roles[0]?.length ?? 1).fill("text"));
	}
	const title = sub.title || sub.id;
	set(minX, topY, "┌", "border", true);
	const titleText = ` ${title} `;
	const titleStart = minX + 1;
	putText(titleStart, topY, titleText, "title", true);
	const inner = maxX - minX - 1 - titleText.length;
	if (inner > 0) {
		const left = Math.floor(inner / 2);
		hLine(titleStart + titleText.length, titleStart + titleText.length + left - 1, topY, "─", "border");
		hLine(titleStart + titleText.length + left, maxX - 1, topY, "─", "border");
	}
	set(maxX, topY, "┐", "border");
	for (let y = topY + 1; y <= maxY; y++) {
		set(minX, y, "│", "border");
		set(maxX, y, "│", "border");
	}
	set(minX, maxY + 1, "└", "border");
	hLine(minX + 1, maxX - 1, maxY + 1, "─", "border");
	set(maxX, maxY + 1, "┘", "border");
}
