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
import { createIpythonTool, createIpythonToolDefinition, type IpythonToolOptions } from "./ipython.js";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.js";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.js";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "ipython" | "read" | "write";
export const allToolNames: Set<ToolName> = new Set(["ipython", "read", "write"]);

export interface ToolsOptions {
	ipython?: IpythonToolOptions;
	read?: ReadToolOptions;
	write?: WriteToolOptions;
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	switch (toolName) {
		case "ipython":
			return createIpythonToolDefinition(cwd, options?.ipython);
		case "read":
			return createReadToolDefinition(cwd, options?.read);
		case "write":
			return createWriteToolDefinition(cwd, options?.write);
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
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return {
		ipython: createIpythonToolDefinition(cwd, options?.ipython),
		read: createReadToolDefinition(cwd, options?.read),
		write: createWriteToolDefinition(cwd, options?.write),
	};
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return {
		ipython: createIpythonTool(cwd, options?.ipython),
		read: createReadTool(cwd, options?.read),
		write: createWriteTool(cwd, options?.write),
	};
}
