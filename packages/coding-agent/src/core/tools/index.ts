export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.js";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.js";
export { withFileMutationQueue } from "./file-mutation-queue.js";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.js";
export {
	createIpythonTool,
	createIpythonToolDefinition,
	IpythonKernelProvisioner,
	type IpythonToolDetails,
	type IpythonToolInput,
	type IpythonToolOptions,
} from "./ipython.js";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.js";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.js";
export {
	createWebFetchTool,
	createWebFetchToolDefinition,
	type WebFetchOperations,
	type WebFetchToolDetails,
	type WebFetchToolInput,
	type WebFetchToolOptions,
} from "./web-fetch.js";
export {
	createWebSearchTool,
	createWebSearchToolDefinition,
	type RawSearchResult,
	type SearchResult,
	type WebSearchOperations,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.js";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteLineEndings,
	type WriteMode,
	type WriteOperations,
	type WriteToolDetails,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.js";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.js";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.js";
import { createIpythonTool, createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createWebFetchTool, createWebFetchToolDefinition, type WebFetchToolOptions } from "./web-fetch.js";
import { createWebSearchTool, createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "ipython" | "read" | "write" | "grep" | "web_search" | "web_fetch";
export const allToolNames: Set<ToolName> = new Set(["ipython", "read", "write", "grep", "web_search", "web_fetch"]);

export interface ToolsOptions {
	ipython?: IpythonToolOptions;
	read?: ReadToolOptions;
	write?: WriteToolOptions;
	grep?: GrepToolOptions;
	webSearch?: WebSearchToolOptions;
	webFetch?: WebFetchToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "ipython":
			return createIpythonToolDefinition(cwd, options?.ipython);
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "web_search":
			return createWebSearchToolDefinition(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchToolDefinition(cwd, options?.webFetch);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	switch (toolName) {
		case "ipython":
			return createIpythonTool(cwd, options?.ipython);
		case "read":
			return createReadTool(cwd, options?.read);
		case "write":
			return createWriteTool(cwd, options?.write);
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "web_search":
			return createWebSearchTool(cwd, options?.webSearch);
		case "web_fetch":
			return createWebFetchTool(cwd, options?.webFetch);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ipython: createIpythonToolDefinition(cwd, options?.ipython),
		read: createReadToolDefinition(cwd, options?.read),
		write: createWriteToolDefinition(cwd, options?.write),
		grep: createGrepToolDefinition(cwd, options?.grep),
		web_search: createWebSearchToolDefinition(cwd, options?.webSearch),
		web_fetch: createWebFetchToolDefinition(cwd, options?.webFetch),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		ipython: createIpythonTool(cwd, options?.ipython),
		read: createReadTool(cwd, options?.read),
		write: createWriteTool(cwd, options?.write),
		grep: createGrepTool(cwd, options?.grep),
		web_search: createWebSearchTool(cwd, options?.webSearch),
		web_fetch: createWebFetchTool(cwd, options?.webFetch),
	};
}
