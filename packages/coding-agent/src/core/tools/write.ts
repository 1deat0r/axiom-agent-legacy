import type { Stats } from "node:fs";
import {
	chmod,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile as fsWriteFile,
	open,
	rename,
	rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { detectLineEnding, generateDiffString, normalizeToLF, restoreLineEndings, stripBom } from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToCwd } from "./path-utils.js";
import { str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { formatSize } from "./truncate.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Full file content to write" }),
	mode: Type.Optional(
		Type.Union([Type.Literal("create"), Type.Literal("overwrite")], {
			description: 'Write mode: "create" fails if the file exists (default), "overwrite" replaces atomically',
		}),
	),
	lineEndings: Type.Optional(
		Type.Union([Type.Literal("lf"), Type.Literal("crlf")], {
			description: "Explicit line ending for the written file (default: preserve on overwrite, LF on create)",
		}),
	),
});

export type WriteToolInput = Static<typeof writeSchema>;
export type WriteMode = "create" | "overwrite";
export type WriteLineEndings = "lf" | "crlf";

export interface WriteToolDetails {
	/** Absolute path that was written. */
	path: string;
	/** The write mode that ran. */
	mode: WriteMode;
	/** Whether the file was created (versus replaced). */
	created: boolean;
	/** Bytes written. */
	bytesWritten: number;
	/** Lines written. */
	linesWritten: number;
	/** Unified diff for overwrites of existing files, undefined for creates. */
	diff?: string;
	/** Line endings used in the written file. */
	lineEndings: WriteLineEndings;
	/** Whether a BOM was written. */
	bomWritten: boolean;
}

export interface WriteOperations {
	/** Stats for the path, or null when it does not exist. */
	stat(path: string): Promise<Stats | null>;
	readFile(path: string): Promise<string>;
	/** Exclusive create (O_EXCL): throws EEXIST when the path exists. */
	writeExclusive(path: string, content: string): Promise<void>;
	/** Atomic replace: temp file in the same directory, then rename. */
	writeAtomic(path: string, content: string, options: { mode?: number }): Promise<void>;
}

export const defaultWriteOperations: WriteOperations = {
	async stat(path) {
		try {
			return await fsStat(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") {
				return null;
			}
			throw error;
		}
	},
	readFile: (path) => fsReadFile(path, "utf8"),
	async writeExclusive(path, content) {
		const handle = await open(path, "wx");
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
	},
	async writeAtomic(path, content, options) {
		const tempPath = join(
			dirname(path),
			`.${basename(path)}.axiom-tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
		);
		try {
			await fsWriteFile(tempPath, content, "utf8");
			if (options.mode !== undefined) {
				await chmod(tempPath, options.mode);
			}
			await rename(tempPath, path);
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}
	},
};

export interface WriteToolOptions {
	/** Injectable operations for tests. */
	operations?: WriteOperations;
}

function validateWriteInput(input: WriteToolInput): {
	path: string;
	content: string;
	mode: WriteMode;
	lineEndings: WriteLineEndings | undefined;
} {
	const path = str(input.path);
	if (path === null || path === "") {
		throw new Error("Write tool input is invalid. path must be a non-empty string.");
	}
	const content = str(input.content);
	if (content === null) {
		throw new Error("Write tool input is invalid. content must be a string.");
	}
	const mode = input.mode ?? "create";
	if (mode !== "create" && mode !== "overwrite") {
		throw new Error('Write tool input is invalid. mode must be "create" or "overwrite".');
	}
	const lineEndings = input.lineEndings;
	if (lineEndings !== undefined && lineEndings !== "lf" && lineEndings !== "crlf") {
		throw new Error('Write tool input is invalid. lineEndings must be "lf" or "crlf".');
	}
	return { path, content, mode, lineEndings };
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	const lines = text.split("\n").length;
	return text.endsWith("\n") ? lines - 1 : lines;
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error ? (error as { code?: string }).code : undefined;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;

	const definition: ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> = {
		name: "write",
		label: "write",
		description:
			'Write a whole file. Default mode "create" fails if the file exists (race-free exclusive create). Mode "overwrite" replaces atomically via temp file plus rename in the same directory, preserves the existing file\'s permissions, line endings, and BOM, and returns a unified diff. Overwrite replaces a symlink rather than writing through it. Parent directories must exist.',
		promptSnippet: "Write whole files with exclusive-create and atomic-overwrite semantics",
		parameters: writeSchema,
		async execute(_toolCallId, rawInput, signal?, _onUpdate?, _ctx?) {
			const { path, content, mode, lineEndings } = validateWriteInput(rawInput as WriteToolInput);
			const absolutePath = resolveToCwd(path, cwd);

			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			return withFileMutationQueue(absolutePath, async () => {
				const stats = await ops.stat(absolutePath);
				const exists = stats !== null;

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				if (exists && stats?.isDirectory()) {
					throw new Error(`Path is a directory, not a file: ${path}. The write tool writes files only.`);
				}

				if (mode === "create") {
					if (exists) {
						throw new Error(`File already exists: ${path}. Pass mode="overwrite" to replace it.`);
					}
					const ending: WriteLineEndings = lineEndings ?? "lf";
					const normalized = restoreLineEndings(normalizeToLF(content), ending === "crlf" ? "\r\n" : "\n");
					try {
						await ops.writeExclusive(absolutePath, normalized);
					} catch (error) {
						const code = errorCode(error);
						if (code === "EEXIST") {
							throw new Error(`File already exists: ${path}. Pass mode="overwrite" to replace it.`);
						}
						if (code === "ENOENT") {
							throw new Error(`Could not write file: ${path}. The parent directory does not exist.`);
						}
						throw error;
					}
					if (signal?.aborted) {
						throw new Error("Operation aborted");
					}
					return {
						content: [
							{
								type: "text",
								text: `Wrote ${path} (${countLines(normalized)} lines, ${formatSize(Buffer.byteLength(normalized, "utf8"))})`,
							},
						],
						details: {
							path: absolutePath,
							mode,
							created: true,
							bytesWritten: Buffer.byteLength(normalized, "utf8"),
							linesWritten: countLines(normalized),
							lineEndings: ending,
							bomWritten: false,
						},
					};
				}

				// Overwrite mode.
				const oldContent = exists ? await ops.readFile(absolutePath) : null;

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const oldBom = oldContent !== null ? stripBom(oldContent).bom : "";
				const newStripped = stripBom(content);
				const bomWritten = oldBom !== "" || newStripped.bom !== "";
				const ending: WriteLineEndings =
					lineEndings ?? (oldContent !== null && detectLineEnding(oldContent) === "\r\n" ? "crlf" : "lf");
				const body = newStripped.text;
				const normalized = `${bomWritten ? "\uFEFF" : ""}${restoreLineEndings(
					normalizeToLF(body),
					ending === "crlf" ? "\r\n" : "\n",
				)}`;

				const diff =
					oldContent !== null
						? generateDiffString(normalizeToLF(oldContent), normalizeToLF(normalized)).diff
						: undefined;

				try {
					await ops.writeAtomic(absolutePath, normalized, {
						mode: exists && stats ? stats.mode & 0o777 : undefined,
					});
				} catch (error) {
					const code = errorCode(error);
					if (code === "ENOENT") {
						throw new Error(`Could not write file: ${path}. The parent directory does not exist.`);
					}
					throw error;
				}

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const lines = countLines(normalized);
				const bytes = Buffer.byteLength(normalized, "utf8");
				const header = `Wrote ${path} (${lines} lines, ${formatSize(bytes)})`;
				return {
					content: [{ type: "text", text: diff ? `${header}\n${diff}` : header }],
					details: {
						path: absolutePath,
						mode,
						created: !exists,
						bytesWritten: bytes,
						linesWritten: lines,
						diff,
						lineEndings: ending,
						bomWritten,
					},
				};
			});
		},
	};
	return definition;
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
