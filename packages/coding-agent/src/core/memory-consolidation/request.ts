/**
 * Session → consolidation request. Mirrors the refine planner's input path
 * (serializeConversation + convertToLlm) so the model sees the same stable,
 * bounded text representation of the run it just finished.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { serializeConversation } from "../compaction/utils.js";
import { convertToLlm } from "../messages.js";
import type { ConsolidationRequest, MemoryOverviewEntry } from "./types.js";

/** Default tail budget for the session text (auto-refine review uses 40k). */
export const MAX_CONVERSATION_CHARS = 40_000;

/** Serialize a completed session to bounded text (keep the newest tail). */
export function serializeSessionForConsolidation(
	messages: readonly AgentMessage[],
	maxChars: number = MAX_CONVERSATION_CHARS,
): string {
	const text = serializeConversation(convertToLlm(messages as AgentMessage[]));
	if (text.length <= maxChars) {
		return text;
	}
	return text.slice(-maxChars);
}

export interface BuildConsolidationRequestOptions {
	sessionId?: string;
	existingMemories?: readonly MemoryOverviewEntry[];
	maxChars?: number;
}

export function buildConsolidationRequest(
	messages: readonly AgentMessage[],
	options: BuildConsolidationRequestOptions = {},
): ConsolidationRequest {
	return {
		conversationText: serializeSessionForConsolidation(messages, options.maxChars),
		existingMemories: options.existingMemories ?? [],
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
	};
}
