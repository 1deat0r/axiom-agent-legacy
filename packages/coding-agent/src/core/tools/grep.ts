import { spawn } from "node:child_process";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.js";
import type { ToolDefinition } from "../extensions/types.js";
import { resolveToCwd } from "./path-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.js";

export const GREP_DEFAULT_LIMIT = 100;
export const GREP_MAX_LIMIT = 2000;
/** Hard stdout buffer cap for one ripgrep run; beyond it the search must be narrowed. */
export const GREP_MAX_RG_OUTPUT_BYTES = 8 * 1024 * 1024;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex, or a literal string with literal=true)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File-name glob filter, e.g. '*.ts' or '**/*.spec.ts'" })),
	mode: Type.Optional(
		Type.Union([Type.Literal("files"), Type.Literal("content")], {
			default: "files",
			description: "files: matching file paths sorted by last-modified; content: matching lines with line numbers",
		}),
	),
	context: Type.Optional(
		Type.Number({ description: "Content mode only: lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(
		Type.Number({
			description: `Maximum number of files (files mode) or matches (content mode) to return (default: ${GREP_DEFAULT_LIMIT}, max: ${GREP_MAX_LIMIT})`,
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat the pattern as a literal string, not a regex (default: false)" }),
	),
});

export type GrepToolInput = Static<typeof grepSchema>;
export type GrepMode = "files" | "content";

export interface GrepToolDetails {
	/** Present when the effective limit cut the result set. */
	matchLimitReached?: number;
	/** Present when at least one returned line was longer than the per-line cap. */
	linesTruncated?: boolean;
	/** Present when the byte cap cut the final text. */
	truncation?: { truncated: boolean; maxBytes?: number };
	/** Present when files mode fell back because the installed ripgrep lacks --sortr. */
	sortFallback?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Run ripgrep with the given args. `code` is null when the run was killed. */
	runRg: (args: string[], signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;
	/** Read a file's lines for context rendering (content mode). */
	readFileLines: (filePath: string) => Promise<string[]>;
	/** Stat the search path; rejects when the path does not exist. */
	statPath: (filePath: string) => Promise<{ isDirectory: boolean }>;
}

export function createDefaultGrepOperations(rgPath: string): GrepOperations {
	return {
		runRg: (args, signal) =>
			new Promise((resolve) => {
				const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				let stderr = "";
				let overflow = false;
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				const cleanup = () => signal?.removeEventListener("abort", onAbort);
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
					if (stdout.length > GREP_MAX_RG_OUTPUT_BYTES && !overflow) {
						overflow = true;
						stderr = `ripgrep output exceeded the ${GREP_MAX_RG_OUTPUT_BYTES} byte cap; narrow the search`;
						child.kill();
					}
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});
				child.on("error", (error) => {
					cleanup();
					resolve({ code: null, stdout, stderr: error.message });
				});
				child.on("close", (code) => {
					cleanup();
					resolve({ code, stdout, stderr });
				});
			}),
		readFileLines: async (filePath) => {
			const content = await fsReadFile(filePath, "utf8");
			return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		},
		statPath: async (filePath) => {
			const st = await fsStat(filePath);
			return { isDirectory: st.isDirectory() };
		},
	};
}

/** Build ripgrep args shared by both modes. */
function buildCommonArgs(pattern: string, searchPath: string, input: GrepToolInput): string[] {
	const args: string[] = [];
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob);
	args.push("--", pattern, searchPath);
	return args;
}

/** Render a file path relative to the searched directory; basename when searching one file. */
function formatFilePath(filePath: string, searchPath: string, isDirectory: boolean): string {
	if (isDirectory) {
		const rel = relative(searchPath, filePath);
		if (rel && !rel.startsWith("..")) return rel.replace(/\\/g, "/");
	}
	return basename(filePath);
}

export function effectiveLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(limit ?? GREP_DEFAULT_LIMIT, GREP_MAX_LIMIT));
}

/** Map a killed ripgrep run to the right error: abort, or the output cap. */
function killedByResult(result: { stderr: string }, signal?: AbortSignal): Error {
	if (signal?.aborted) return new Error("Operation aborted");
	const message = result.stderr.trim();
	return new Error(message || "ripgrep was interrupted");
}

/** Parse one `rg --json` stdout line into a match event, or null. */
function parseMatchLine(line: string): { filePath: string; lineNumber: number; lineText: string } | null {
	let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
	try {
		event = JSON.parse(line);
	} catch {
		return null;
	}
	if (event.type !== "match") return null;
	const filePath = event.data?.path?.text;
	const lineNumber = event.data?.line_number;
	const lineText = event.data?.lines?.text;
	if (!filePath || typeof lineNumber !== "number") return null;
	return { filePath, lineNumber, lineText: lineText ?? "" };
}

/**
 * Run a grep search. The whole behaviour of the tool lives behind this one
 * seam: arg building, mode handling, caps, error mapping, and formatting.
 */
export async function runGrepSearch(
	input: GrepToolInput,
	cwd: string,
	ops: GrepOperations,
	signal?: AbortSignal,
): Promise<{ text: string; details: GrepToolDetails }> {
	if (signal?.aborted) {
		throw new Error("Operation aborted");
	}
	const searchPath = resolveToCwd(input.path ?? ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = (await ops.statPath(searchPath)).isDirectory;
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}

	const limit = effectiveLimit(input.limit);
	const mode: GrepMode = input.mode ?? "files";
	const details: GrepToolDetails = {};

	const run = async (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> => {
		if (signal?.aborted) throw new Error("Operation aborted");
		return ops.runRg(args, signal);
	};

	if (mode === "files") {
		let args: string[] = [
			"--files-with-matches",
			"--sortr=modified",
			...buildCommonArgs(input.pattern, searchPath, input),
		];
		let result = await run(args);
		if (result.code === 2 && result.stderr.includes("sortr")) {
			// ripgrep older than 14.0 lacks --sortr: retry without it, keep rg order.
			details.sortFallback = true;
			args = ["--files-with-matches", ...buildCommonArgs(input.pattern, searchPath, input)];
			result = await run(args);
		}
		if (result.code === null) throw killedByResult(result, signal);
		if (result.code === 2) {
			throw new Error(result.stderr.trim() || "ripgrep failed");
		}
		const files = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
		if (files.length === 0) {
			return { text: "No matches found", details };
		}
		const shown = files.slice(0, limit).map((file) => formatFilePath(file, searchPath, isDirectory));
		if (files.length > limit) details.matchLimitReached = limit;
		return { text: shown.join("\n"), details };
	}

	// content mode
	const contextValue = input.context && input.context > 0 ? input.context : 0;
	const args = [
		"--json",
		"--line-number",
		"--color=never",
		"--hidden",
		...buildCommonArgs(input.pattern, searchPath, input),
	];
	const result = await run(args);
	if (result.code === null) throw killedByResult(result, signal);
	if (result.code === 2) {
		throw new Error(result.stderr.trim() || "ripgrep failed");
	}
	const matches: Array<{ filePath: string; lineNumber: number; lineText: string }> = [];
	for (const line of result.stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		if (matches.length >= limit) {
			details.matchLimitReached = limit;
			break;
		}
		const match = parseMatchLine(line);
		if (match) matches.push(match);
	}
	if (matches.length === 0) {
		return { text: "No matches found", details };
	}
	if (matches.length >= limit) details.matchLimitReached = limit;

	const fileCache = new Map<string, string[]>();
	const getFileLines = async (filePath: string): Promise<string[]> => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				lines = await ops.readFileLines(filePath);
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};

	const blocks: string[] = [];
	for (const match of matches) {
		const relativePath = formatFilePath(match.filePath, searchPath, isDirectory);
		if (contextValue > 0) {
			const lines = await getFileLines(match.filePath);
			if (lines.length === 0) {
				blocks.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
				continue;
			}
			const start = Math.max(1, match.lineNumber - contextValue);
			const end = Math.min(lines.length, match.lineNumber + contextValue);
			for (let current = start; current <= end; current++) {
				const { text: truncatedText, wasTruncated } = truncateLine((lines[current - 1] ?? "").replace(/\r/g, ""));
				if (wasTruncated) details.linesTruncated = true;
				blocks.push(
					current === match.lineNumber
						? `${relativePath}:${current}: ${truncatedText}`
						: `${relativePath}-${current}- ${truncatedText}`,
				);
			}
		} else {
			const { text: truncatedText, wasTruncated } = truncateLine(match.lineText);
			if (wasTruncated) details.linesTruncated = true;
			blocks.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
		}
	}

	const truncation = truncateHead(blocks.join("\n"));
	if (truncation.truncated) details.truncation = truncation;
	return { text: truncation.content, details };
}

export const grepToolSystemPromptContribution = {
	snippet: "Search the file system for a pattern with ripgrep (respects .gitignore)",
	guidelines: [
		"Prefer this tool over ad-hoc bash grep. For questions about code structure (definitions, call sites by shape), use the ast-grep skill instead.",
	],
} as const;

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep. */
	operations?: GrepOperations;
	/** Resolve the ripgrep binary. Default: ensureTool(\"rg\") which downloads when allowed. */
	ensureRg?: () => Promise<string | undefined>;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Files mode returns matching file paths sorted by last-modified. Content mode returns matching lines with file path, line number, and optional context lines. Respects .gitignore. Output caps at ${GREP_DEFAULT_LIMIT} results (max ${GREP_MAX_LIMIT}) or ${DEFAULT_MAX_BYTES / 1024}KB; long lines truncate at ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(_toolCallId, input: GrepToolInput, signal?: AbortSignal) {
			const ensure = options?.ensureRg ?? (() => ensureTool("rg"));
			const rgPath = await ensure();
			if (!rgPath) {
				throw new Error("ripgrep (rg) is not available and could not be downloaded");
			}
			const ops = options?.operations ?? createDefaultGrepOperations(rgPath);
			const { text, details } = await runGrepSearch(input, cwd, ops, signal);
			return { content: [{ type: "text", text }], details };
		},
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
