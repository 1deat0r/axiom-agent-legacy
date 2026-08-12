/**
 * Sensitive-tool fence (ADR-0028, security fence) — pure gate.
 *
 * On an anchored project this guard runs on every `tool_call` and returns a
 * `{ block, reason }` when the invocation should not proceed. Two orthogonal
 * rules:
 *
 *  1. Egress / URL gate: any tool carrying a `url` argument (a fetch channel)
 *     is poked through `checkUrlSafety`. This is the "URL-safe fetch" half.
 *  2. Approved-tool ladder: if the tool name is in the configured
 *     `sensitiveTools` set and not in `approvedTools`, it is blocked. The
 *     built-in sensitive set is deliberately EMPTY (opt-in) — we do not pretend
 *     to fence freeform tools (`bash`/`ipython` are the ADR-0018 OS-sandbox
 *     tier); an operator names which tools are sensitive for their project and
 *     approves them for a task via the escape hatch (`AXIOM_FENCE_ALLOW`).
 */
import { checkUrlSafety, type UrlSafetyOptions } from "./url.js";

export interface SensitiveToolFenceOptions extends UrlSafetyOptions {
	/** Sensitive tool names — blocked in anchored runs unless approved. Default [] (opt-in). */
	sensitiveTools?: string[];
	/** Approved tool names — escape hatch that unblocks a sensitive tool. */
	approvedTools?: string[];
}

export type FenceDecision = { block: true; reason: string } | undefined;

/** First non-empty string `url` field from a tool-call args object, if any. */
export function extractUrlField(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const v = (input as Record<string, unknown>).url;
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Decision for one tool call: `undefined` to allow, or a block with a reason. */
export function checkSensitiveTool(
	toolName: string,
	input: unknown,
	options: SensitiveToolFenceOptions = {},
): FenceDecision {
	const url = extractUrlField(input);
	if (url !== undefined) {
		const d = checkUrlSafety(url, options);
		if (d) return d;
	}
	const approved = new Set(options.approvedTools ?? []);
	if ((options.sensitiveTools ?? []).includes(toolName) && !approved.has(toolName)) {
		return {
			block: true,
			reason:
				`Refusing tool '${toolName}' — it is outside this project's approved-tool fence. ` +
				`Add it to the approved set (AXIOM_FENCE_ALLOW) if you intend it for this task.`,
		};
	}
	return undefined;
}
