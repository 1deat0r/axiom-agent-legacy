/**
 * Security fence extension (ADR-0028) — tool seam wiring.
 *
 * Ships the two pure gates from this module on the `tool_call` seam, gated to
 * AXIOM-surface runs exactly like the workspace root guard: INERT unless a run
 * is anchored by AXIOM_PROJECT_ROOT (or an explicit deps.root), so ordinary
 * `axiom` runs are unaffected. When anchored:
 *  - any tool call carrying a `url` argument is poked through the URL-safe
 *    fetch gate (scheme / credentials / SSRF hosts; named http(s) hosts are
 *    DNS-resolved and classified per ADR-0057, failing closed on resolution
 *    errors);
 *  - any tool in the configured `sensitiveTools` set is blocked unless approved.
 *
 * Configuration is via the options object (tests) or env for real runs:
 *  - AXIOM_FENCE_ALLOW         comma-separated approved tool names (escape)
 *  - AXIOM_FENCE_ALLOW_HOSTS   comma-separated allowed URL hosts (escape)
 */
import type { ExtensionAPI } from "../../core/extensions/types.js";
import { checkSensitiveTool, type SensitiveToolFenceOptions } from "./fence.js";

/** Parse a comma-separated env list, trimming empties; undefined when unset. */
function envList(value: string | undefined): string[] | undefined {
	if (!value || value.length === 0) return undefined;
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export interface SecurityFenceOptions extends SensitiveToolFenceOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
}

/**
 * Build the security-fence extension. Returns a factory `(pi) => void`; when no
 * project root is configured the factory is a no-op (inert), keeping the blast
 * radius to anchored gateway/project runs.
 */
export function createSecurityFence(options: SecurityFenceOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const rawRoot = options.root ?? process.env.AXIOM_PROJECT_ROOT;
		if (!rawRoot) return; // inert unless a project root is anchored
		const sensitiveTools = options.sensitiveTools ?? [];
		const approvedTools = options.approvedTools ?? envList(process.env.AXIOM_FENCE_ALLOW) ?? [];
		const allowHosts = options.allowHosts ?? envList(process.env.AXIOM_FENCE_ALLOW_HOSTS) ?? [];
		const allowedSchemes = options.allowedSchemes;
		const resolver = options.resolver;
		const dnsTimeoutMs = options.dnsTimeoutMs;
		pi.on("tool_call", async (event) => {
			// Fast path: nothing to gate when there's no URL field and the tool
			// isn't in the sensitive set.
			const rawUrl = (event.input as Record<string, unknown> | undefined)?.url;
			const isSensitive = sensitiveTools.includes(event.toolName);
			if (typeof rawUrl !== "string" && !isSensitive) return undefined;
			return await checkSensitiveTool(event.toolName, event.input, {
				sensitiveTools,
				approvedTools,
				allowHosts,
				allowedSchemes,
				resolver,
				dnsTimeoutMs,
			});
		});
	};
}

export default function axiomSecurityExtension(pi: ExtensionAPI): void {
	createSecurityFence()(pi);
}

export { checkSensitiveTool, extractUrlField } from "./fence.js";
export {
	buildPinnedRequestOptions,
	DEFAULT_MAX_REDIRECTS,
	defaultPinnedFetcher,
	type FetchPinnedOptions,
	fetchPinned,
	makePinningLookup,
	type PinnedFetcher,
	type PinnedRequestOptions,
	UrlGateBlockError,
} from "./fetch-pinned.js";
export {
	checkUrlSafety,
	checkUrlSafetyPinned,
	DEFAULT_DNS_TIMEOUT_MS,
	type HostnameResolver,
	isPrivateIPv4,
	isPrivateIPv6,
	type LookupFn,
	makeDefaultResolver,
	type PinnedResolution,
	type ResolvedAddress,
	type UrlGateVerdict,
} from "./url.js";
