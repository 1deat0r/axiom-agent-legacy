/**
 * Root guard extension (ADR-0052) — freeform path confinement + approval.
 *
 * Ships the rung-3 gate over the freeform file-touching tools on the
 * `tool_call` seam, gated exactly like the security fence and the git guard:
 * INERT unless a run is anchored by AXIOM_PROJECT_ROOT (or an explicit
 * deps.root), so ordinary `axiom` runs are unaffected. When anchored:
 *
 *  - `bash` (input.command) and `ipython` (input.code) are scanned for
 *    literal path tokens; tokens outside the project root block the call
 *    with a plain-English reason — strict block-by-default (issue #17,
 *    criterion a), relaxed only by an operator allow prefix or an approved
 *    grant. The exported INFRA_ALLOW_PREFIXES list is the convenience set an
 *    operator pastes into AXIOM_ROOT_GUARD_ALLOW to restore the practical
 *    posture.
 *  - `request_root_access` is registered: the model files a plain-English
 *    request for outside paths and WAITS (polling, abortable) for the
 *    operator's decision via `axiom root-guard approve|reject <id>`. An
 *    approval records a grant that unblocks later calls to those paths.
 *  - Every block, request, decision, grant, and grant-use is audited to an
 *    append-only JSONL — an outside path is never silently allowed.
 *
 * The `edit` tool stays with the workspace guard (ADR-0018), which gains the
 * same allow prefixes and grants so an approved escape also unblocks edits.
 *
 * Configuration:
 *  - AXIOM_ROOT_GUARD_ALLOW            comma-separated allow prefixes (escape
 *                                      policy; paste INFRA_ALLOW_PREFIXES here
 *                                      to allow the OS read surface + scratch)
 *  - AXIOM_ROOT_GUARD_DENY             comma-separated deny prefixes (win)
 *  - AXIOM_ROOT_GUARD_STATE_DIR        approval state root (default axiom home)
 *  - AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS  approval wait budget (default 5 min)
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { envList } from "../../core/env-list.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import { extractCandidatePaths } from "../../core/root-guard/paths.js";
import { checkPathScope, isWithinPath, toAbsolutePath } from "../../core/root-guard/scope.js";
import {
	appendAudit,
	appendGrantIfMissing,
	fileRequest,
	listGrantPrefixes,
	readDecision,
	resolveScopeDir,
} from "../../core/root-guard/store.js";
import { axiomHome } from "../profile/registry.js";

/**
 * The infra allowlist — OS read surfaces, scratch, and the agent's own homes,
 * the same surfaces ADR-0019 keeps visible. Deliberately NOT home data
 * (Documents, other projects, .ssh/.aws/.gnupg/.netrc, dotfiles), /var,
 * /mnt, /media, /srv, or other users' homes.
 *
 * OPT-IN by design (ADR-0052): the guard is strict block-by-default, so this
 * list is NOT applied automatically. An operator pastes it into
 * AXIOM_ROOT_GUARD_ALLOW to restore the practical posture. This is a drift
 * guard, not a sandbox — ADR-0019 stays the strict tier.
 */
export function INFRA_ALLOW_PREFIXES(home: string, axiomHomeDir: string): string[] {
	return [
		"/proc",
		"/sys",
		"/dev",
		"/run",
		"/tmp",
		"/usr",
		"/bin",
		"/lib",
		"/lib64",
		"/etc",
		"/opt",
		"/sbin",
		axiomHomeDir,
		join(home, ".local"),
		join(home, ".config"),
		join(home, ".cache"),
	];
}

export interface RootGuardOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
	/**
	 * Base for resolving relative paths (tests). Defaults to the project root:
	 * the ipython kernel can `%cd` elsewhere, so process.cwd() is not the
	 * invariant — the anchored root is.
	 */
	cwd?: string;
	/**
	 * Approval state root (tests). Defaults to AXIOM_ROOT_GUARD_STATE_DIR or
	 * the axiom home; the store appends root-guard/<rootHash>/ below it.
	 */
	stateDir?: string;
	/** Home used for `~` expansion. Defaults to the process home. */
	home?: string;
	/** Extra allow prefixes. Defaults to AXIOM_ROOT_GUARD_ALLOW (strict otherwise). */
	allowPrefixes?: readonly string[];
	/** Deny prefixes (win over allows, even inside the root). Defaults to AXIOM_ROOT_GUARD_DENY. */
	denyPrefixes?: readonly string[];
	/** Approval wait budget in ms (default 300000). */
	approvalTimeoutMs?: number;
	/** Approval poll interval in ms (default 500). */
	pollMs?: number;
}

/** Shell text from a tool-call input, or undefined for non-shell tools. */
function shellText(toolName: string, input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as Record<string, unknown>;
	if (toolName === "bash") {
		const command = record.command;
		return typeof command === "string" ? command : undefined;
	}
	if (toolName === "ipython") {
		const code = record.code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}

function sleepMs(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((done) => {
		if (signal?.aborted) {
			done();
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			done();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			done();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

const RequestAccessSchema = Type.Object({
	paths: Type.Array(Type.String(), { minItems: 1 }),
	reason: Type.String({ minLength: 1 }),
});
type RequestAccessParams = Static<typeof RequestAccessSchema>;

/**
 * Build the root-guard extension. Returns a factory `(pi) => void`; when no
 * project root is configured the factory is a no-op (inert), keeping the
 * blast radius to anchored gateway/project runs.
 */
export function createRootGuard(options: RootGuardOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const rawRoot = options.root ?? process.env.AXIOM_PROJECT_ROOT;
		if (!rawRoot) return; // inert unless a project root is anchored
		const cwd = options.cwd ?? rawRoot;
		const home = options.home ?? homedir();
		// resolveScopeDir appends the root-guard segment: the default state
		// root is the axiom home, so the layout is <axiom home>/root-guard/<rootHash>/.
		const stateDir = options.stateDir ?? process.env.AXIOM_ROOT_GUARD_STATE_DIR ?? axiomHome();
		const allowPrefixes = options.allowPrefixes ?? envList(process.env.AXIOM_ROOT_GUARD_ALLOW) ?? [];
		const denyPrefixes = options.denyPrefixes ?? envList(process.env.AXIOM_ROOT_GUARD_DENY) ?? [];
		const envTimeout = Number.parseInt(process.env.AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS ?? "", 10);
		const timeoutMs =
			options.approvalTimeoutMs ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300000);
		const pollMs = options.pollMs ?? 500;
		const customStateDir = options.stateDir ?? process.env.AXIOM_ROOT_GUARD_STATE_DIR;
		// The operator's terminal usually does not share the run's env, so the
		// relayed command must carry --root (and --state-dir when customized).
		const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;
		const operatorCommand = (id: string, verb: "approve" | "reject" = "approve"): string =>
			`axiom root-guard ${verb} ${id} --root ${shellQuote(rawRoot)}` +
			(customStateDir ? ` --state-dir ${shellQuote(customStateDir)}` : "");

		pi.on("tool_call", async (event) => {
			const text = shellText(event.toolName, event.input);
			if (text === undefined) return undefined;
			const tokens = extractCandidatePaths(text);
			if (tokens.length === 0) return undefined;
			// Static policy first: inside-root (and policy-allowed) calls never
			// touch the approval store, so a broken store cannot block them.
			const decision = checkPathScope({
				root: rawRoot,
				cwd,
				home,
				paths: tokens,
				allowPrefixes,
				denyPrefixes,
			});
			if (!decision) return undefined;
			// Only when the static policy blocks can grants change the
			// outcome — consult the store then, failing closed if it is broken.
			let scope: string;
			let grants: string[];
			try {
				scope = await resolveScopeDir(stateDir, rawRoot);
				grants = await listGrantPrefixes(scope);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					block: true,
					reason:
						`Root guard could not verify these paths because its store failed (${message}). ` +
						`Fix AXIOM_ROOT_GUARD_STATE_DIR (default: <axiom home>/root-guard) and retry.`,
				};
			}
			const withGrants = checkPathScope({
				root: rawRoot,
				cwd,
				home,
				paths: tokens,
				allowPrefixes: [...allowPrefixes, ...grants],
				denyPrefixes,
			});
			if (!withGrants) {
				// A failed use-audit must not turn an authorized call into a raw
				// error: the grant itself is already recorded in grants.jsonl.
				try {
					await appendAudit(scope, { event: "grant-use", tool: event.toolName, paths: decision.paths });
				} catch {
					/* audit degraded; the grant record is the source of truth */
				}
				return undefined;
			}
			// A failed block-audit must not replace the curated plain-English
			// block with a raw store error — the block still stands.
			try {
				await appendAudit(scope, { event: "block", tool: event.toolName, paths: decision.paths });
			} catch {
				/* audit degraded; the block reason still reaches the model */
			}
			return { block: true, reason: decision.reason };
		});

		pi.registerTool({
			name: "request_root_access",
			label: "Request root access",
			description:
				"Request operator approval to touch paths outside this project's root. The root guard " +
				"blocks outside paths by default; when a bash or ipython call is blocked, call this tool " +
				"with the blocked paths and a short plain-English reason. The operator approves or " +
				"rejects with 'axiom root-guard approve <id> --root <root>' / 'axiom root-guard reject " +
				"<id> --root <root>'. This tool " +
				"waits for the decision (up to a few minutes) and reports the outcome. An approval " +
				"applies to later calls automatically — retry the blocked call afterwards.",
			promptGuidelines: [
				"When a bash or ipython call is blocked by the root guard, do not reword around the " +
					"block. Call request_root_access with the exact blocked paths and a plain-English " +
					"reason, and relay the request id to the operator if the wait times out.",
			],
			parameters: RequestAccessSchema,
			execute: async (_toolCallId, params: RequestAccessParams, signal, _onUpdate, _ctx) => {
				let scope: string;
				try {
					scope = await resolveScopeDir(stateDir, rawRoot);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text:
									`Could not file the request because the root-guard store failed (${message}). ` +
									"Fix AXIOM_ROOT_GUARD_STATE_DIR and call this tool again.",
							},
						],
						details: null,
					};
				}
				const rootAbs = resolve(rawRoot);
				const absPaths = params.paths.map((p) => resolve(toAbsolutePath(p, cwd, home)));
				// A deny prefix can never be overridden by a grant: refuse those
				// paths outright instead of filing a request the guard would
				// ignore. This applies to inside-root paths too — the guard
				// blocks a denied path anywhere, so the tool must not tell the
				// model to retry it.
				const deniedByOperator = absPaths.filter((p) =>
					denyPrefixes.some((d) => {
						const norm = resolve(toAbsolutePath(d, cwd, home));
						return norm === p || isWithinPath(norm, p);
					}),
				);
				const requestable = absPaths.filter((p) => !isWithinPath(rootAbs, p) && !deniedByOperator.includes(p));
				if (requestable.length === 0 && deniedByOperator.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									"All requested paths are already inside the project root — no approval is " +
									"needed. Just run the command.",
							},
						],
						details: null,
					};
				}
				if (requestable.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									"The operator permanently denied these paths (AXIOM_ROOT_GUARD_DENY): " +
									`${deniedByOperator.join(", ")}. Do not request them again — find another way.`,
							},
						],
						details: null,
					};
				}
				const deniedNote =
					deniedByOperator.length > 0
						? ` The operator permanently denied these paths (AXIOM_ROOT_GUARD_DENY), so they were ` +
							`dropped from this request: ${deniedByOperator.join(", ")}.`
						: "";
				let id: string;
				try {
					const filed = await fileRequest(scope, { paths: requestable, reason: params.reason });
					id = filed.id;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text:
									`Could not file the request because the root-guard store failed (${message}). ` +
									"Fix AXIOM_ROOT_GUARD_STATE_DIR and call this tool again.",
							},
						],
						details: null,
					};
				}
				try {
					await appendAudit(scope, { event: "request", id, paths: requestable, reason: params.reason });
				} catch (error) {
					// The request IS on the board even when its audit record
					// failed — say so instead of inviting a duplicate request.
					const message = error instanceof Error ? error.message : String(error);
					return {
						content: [
							{
								type: "text",
								text:
									`Request ${id} was filed, but its audit record failed (${message}). ` +
									`The operator can still decide with '${operatorCommand(id)}' or ` +
									`'${operatorCommand(id, "reject")}'.`,
							},
						],
						details: null,
					};
				}
				const deadline = Date.now() + timeoutMs;
				for (;;) {
					const decision = await readDecision(scope, id);
					if (decision) {
						if (decision.approved) {
							// appendGrantIfMissing records the grant AND its audit event
							// only when it appends — one approval, one audit event. A
							// grant-recording failure must not turn an approved call
							// into a raw error; the decision still stands.
							let grantNote = "";
							try {
								await appendGrantIfMissing(scope, { id, prefixes: requestable, reason: params.reason });
							} catch (error) {
								const message = error instanceof Error ? error.message : String(error);
								grantNote =
									` The grant record could not be written (${message}); the operator's ` +
									"decision still stands — retry the call, and re-file if the guard blocks.";
							}
							return {
								content: [
									{
										type: "text",
										text:
											`The operator approved request ${id} for: ${requestable.join(", ")}. ` +
											`Retry the blocked call now — the guard allows these paths.${deniedNote}${grantNote}`,
									},
								],
								details: null,
							};
						}
						// The CLI (the normal decision writer) recorded the reject
						// audit event already; a hand-written decision file is
						// visible in the decisions dir instead.
						return {
							content: [
								{
									type: "text",
									text:
										`The operator rejected request ${id}. Do not touch these paths: ` +
										`${requestable.join(", ")}. Find another way or stop.${deniedNote}`,
								},
							],
							details: null,
						};
					}
					if (signal?.aborted) {
						return {
							content: [
								{
									type: "text",
									text:
										`Request ${id} is still pending (the run was interrupted). The operator can ` +
										`still decide with '${operatorCommand(id)}' or ` +
										`'${operatorCommand(id, "reject")}'; an approval applies to later calls.${deniedNote}`,
								},
							],
							details: null,
						};
					}
					if (Date.now() >= deadline) {
						return {
							content: [
								{
									type: "text",
									text:
										`Request ${id} is still pending after ${timeoutMs}ms. Tell the operator: ` +
										`'${operatorCommand(id)}' to allow these paths (${requestable.join(", ")}) ` +
										`or '${operatorCommand(id, "reject")}' to deny. An approval applies to later ` +
										`calls automatically — retry the blocked call after it.${deniedNote}`,
								},
							],
							details: null,
						};
					}
					await sleepMs(pollMs, signal);
				}
			},
		});
	};
}

export default function axiomRootGuardExtension(pi: ExtensionAPI): void {
	createRootGuard()(pi);
}
