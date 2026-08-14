import type { Stats } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { stripBom } from "./edit-diff.js";
import { resolveReadPath } from "./path-utils.js";
import { shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";

/** Hard ceiling: files at or above this size are rejected with guidance. */
export const READ_HARD_MAX_BYTES = 2 * 1024 * 1024;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	startLine: Type.Optional(Type.Number({ description: "First line to return, 1-based (default: 1)" })),
	endLine: Type.Optional(Type.Number({ description: "Last line to return, 1-based, inclusive (default: last line)" })),
	maxBytes: Type.Optional(
		Type.Number({ description: `Approximate byte cap for the returned content (default: ${DEFAULT_MAX_BYTES})` }),
	),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	/** Absolute path that was read. */
	path: string;
	/** Total lines in the file (after CR and BOM normalization). */
	totalLines: number;
	/** File size in bytes. */
	totalBytes: number;
	/** First line returned (1-based). */
	startLine: number;
	/** Last line returned (1-based). */
	endLine: number;
	/** Whether the returned content was truncated by a cap. */
	truncated: boolean;
	/** Bytes of the returned content. */
	shownBytes: number;
	/** Whether a BOM was present and stripped from the display. */
	bomStripped: boolean;
}

export interface ReadOperations {
	stat(path: string): Promise<Stats>;
	readFile(path: string): Promise<string>;
}

export const defaultReadOperations: ReadOperations = {
	stat: (path) => fsStat(path),
	readFile: (path) => fsReadFile(path, "utf8"),
};

export interface ReadToolOptions {
	/** Injectable operations for tests. */
	operations?: ReadOperations;
	/** Hard byte ceiling override (tests). */
	hardMaxBytes?: number;
}

function validateReadInput(input: ReadToolInput): {
	path: string;
	startLine: number | undefined;
	endLine: number | undefined;
	maxBytes: number;
} {
	const path = str(input.path);
	if (path === null || path === "") {
		throw new Error("Read tool input is invalid. path must be a non-empty string.");
	}
	if (input.startLine !== undefined && (!Number.isInteger(input.startLine) || input.startLine < 1)) {
		throw new Error("Read tool input is invalid. startLine must be a positive integer.");
	}
	if (input.endLine !== undefined && (!Number.isInteger(input.endLine) || input.endLine < 1)) {
		throw new Error("Read tool input is invalid. endLine must be a positive integer.");
	}
	if (input.startLine !== undefined && input.endLine !== undefined && input.endLine < input.startLine) {
		throw new Error(
			`Read tool input is invalid. endLine (${input.endLine}) must be >= startLine (${input.startLine}).`,
		);
	}
	const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isInteger(maxBytes) || maxBytes < 1) {
		throw new Error("Read tool input is invalid. maxBytes must be a positive integer.");
	}
	return { path, startLine: input.startLine, endLine: input.endLine, maxBytes };
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function formatNumberedLines(lines: string[], firstLine: number, lastLine: number): string {
	const width = Math.max(4, String(lastLine).length);
	return lines.map((line, i) => `${String(firstLine + i).padStart(width, " ")}\t${line}`).join("\n");
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const ops = options?.operations ?? defaultReadOperations;
	const hardMaxBytes = options?.hardMaxBytes ?? READ_HARD_MAX_BYTES;
	const hardMaxLabel = `${(hardMaxBytes / (1024 * 1024)).toFixed(1)}MB`;

	const definition: ToolDefinition<typeof readSchema, ReadToolDetails | undefined> = {
		name: "read",
		label: "read",
		description: `Read a file and return its content with line numbers. Supports 1-based line ranges and a byte cap (default ${DEFAULT_MAX_BYTES / 1024}KB). Files at or above ${hardMaxLabel} are rejected with guidance. Rejects directories, non-regular files, and binary content. Never writes.`,
		promptSnippet: "Read files with line numbers, 1-based ranges, and truncation-safe caps",
		parameters: readSchema,
		async execute(_toolCallId, rawInput, signal?, _onUpdate?, _ctx?) {
			const { path, startLine, endLine, maxBytes } = validateReadInput(rawInput as ReadToolInput);
			const absolutePath = resolveReadPath(path, cwd);

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			let stats: Stats;
			try {
				stats = await ops.stat(absolutePath);
			} catch (error: unknown) {
				const code =
					error instanceof Error && "code" in error ? ` Error code: ${(error as { code?: string }).code}.` : "";
				throw new Error(`Could not read file: ${path}.${code}`);
			}

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			if (stats.isDirectory()) {
				throw new Error(
					`Path is a directory, not a file: ${path}. The read tool reads files only; list directories with bash.`,
				);
			}
			if (!stats.isFile()) {
				throw new Error(
					`Path is not a regular file: ${path}. The read tool rejects FIFOs, sockets, and device nodes.`,
				);
			}
			if (stats.size >= hardMaxBytes) {
				throw new Error(
					`File is ${formatSize(stats.size)}, at or above the read cap of ${hardMaxLabel}. Use bash (head or sed) for files this large.`,
				);
			}

			const content = await ops.readFile(absolutePath);

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			if (content.includes("\0")) {
				throw new Error(`Binary file: ${path}. The read tool returns text files only.`);
			}

			const { bom, text: withoutBom } = stripBom(content);
			const normalized = withoutBom.replace(/\r/g, "");
			const totalLines = countLines(normalized);
			const totalBytes = stats.size;
			const bomStripped = bom.length > 0;

			if (totalLines === 0) {
				return {
					content: [{ type: "text", text: `Read ${shortenPath(absolutePath)} (empty file, 0 B)` }],
					details: {
						path: absolutePath,
						totalLines: 0,
						totalBytes,
						startLine: 0,
						endLine: 0,
						truncated: false,
						shownBytes: 0,
						bomStripped,
					},
				};
			}

			const start = startLine ?? 1;
			const requestedEnd = endLine ?? totalLines;
			if (start > totalLines) {
				throw new Error(`startLine ${start} exceeds file length ${totalLines} lines: ${path}.`);
			}
			const end = Math.min(requestedEnd, totalLines);

			const selected = normalized
				.split("\n")
				.slice(start - 1, end)
				.join("\n");
			const truncation = truncateHead(selected, { maxLines: DEFAULT_MAX_LINES, maxBytes: maxBytes });
			const shownLines = truncation.content.length === 0 ? [] : truncation.content.split("\n");
			const shownStart = start;
			const shownEnd = start + shownLines.length - 1;
			const shownBytes = Buffer.byteLength(truncation.content, "utf8");

			let text = `Read ${shortenPath(absolutePath)} (lines ${shownStart}-${shownEnd} of ${totalLines}, ${formatSize(shownBytes)} of ${formatSize(totalBytes)})`;
			if (truncation.content.length > 0) {
				text += `\n${formatNumberedLines(shownLines, shownStart, Math.max(shownStart, shownEnd))}`;
			}
			if (truncation.truncated) {
				text += `\n[Truncated: showing ${formatSize(shownBytes)} of ${formatSize(totalBytes)} (lines ${shownStart}-${shownEnd} of ${totalLines}). Pass startLine/endLine to read further.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: {
					path: absolutePath,
					totalLines,
					totalBytes,
					startLine: shownStart,
					endLine: shownEnd,
					truncated: truncation.truncated,
					shownBytes,
					bomStripped,
				},
			};
		},
	};
	return definition;
}

export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
