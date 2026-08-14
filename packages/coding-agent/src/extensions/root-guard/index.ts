/**
 * Root guard extension (ADR-0052 + hardening) — freeform path gate + approval.
 *
 * Ships the rung-3 gate over the freeform file-touching tools on the
 * `tool_call` seam, gated exactly like the security fence and the git guard:
 * INERT unless a run is anchored by AXIOM_PROJECT_ROOT (or an explicit
 * deps.root), so ordinary `axiom` runs are unaffected. When anchored:
 *
 *  - `bash` (input.command) and `ipython` (input.code) are scanned for
 *    literal AND decoded path tokens (shell-escaped slashes and ANSI-C
 *    $'...' quoting are decoded first); tokens outside the project root
 *    block the call with a plain-English reason — strict block-by-default
 *    (issue #17, criterion a), relaxed only by an operator allow prefix or
 *    a VERIFIED grant. Cells that carry obfuscation markers and name no
 *    known-inside path fail closed; destructive coreutils with a bare-root
 *    operand block outright; cd/chdir through variable targets blocks.
 *    The exported INFRA_ALLOW_PREFIXES list is the convenience set an
 *    operator pastes into AXIOM_ROOT_GUARD_ALLOW to restore the practical
 *    posture.
 *  - `request_root_access` is registered: the model files a plain-English
 *    request for outside paths and WAITS (polling, abortable) for the
 *    operator's decision via `axiom root-guard approve|reject <id>`. An
 *    approval records a SIGNED grant (CLI-written) that unblocks later
 *    calls. Requests for the filesystem root, the operator's home, or the
 *    axiom home are refused — those are operator-CLI-only.
 *  - The state dir (default /var/lib/axiom-root-guard, operator-provisioned)
 *    and the legacy axiom-home store are hard-denied on every seam.
 *
 * The `edit` tool stays with the workspace guard (ADR-0018), which gains the
 * same allow prefixes, grants, and state denies so an approved escape also
 * unblocks edits — and the same tilde expansion the edit tool itself applies.
 *
 * Configuration:
 *  - AXIOM_ROOT_GUARD_ALLOW            comma-separated allow prefixes (escape
 *                                      policy; paste INFRA_ALLOW_PREFIXES here
 *                                      to allow the OS read surface + scratch)
 *  - AXIOM_ROOT_GUARD_DENY             comma-separated deny prefixes (win)
 *  - AXIOM_ROOT_GUARD_STATE_DIR        approval state root (default
 *                                      /var/lib/axiom-root-guard — operator
 *                                      provisions it; never the axiom home)
 *  - AXIOM_ROOT_GUARD_APPROVAL_TIMEOUT_MS  approval wait budget (default 5 min)
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { envList } from "../../core/env-list.js";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	checkDestructiveBareRoot,
	decodeShellEscapes,
	findCdDrift,
	findObfuscationMarkers,
	hasHardMarker,
	hasQuotedSlashString,
	hasSoftMarker,
	shellLinesOfCode,
} from "../../core/root-guard/hardening.js";
import { extractCandidatePaths } from "../../core/root-guard/paths.js";
import { checkPathScope, isWithinPath, toAbsolutePath } from "../../core/root-guard/scope.js";
import {
	appendAudit,
	buildStateDenies,
	defaultRootGuardStateDir,
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
	 * the OPERATOR-OWNED default (/var/lib/axiom-root-guard — never the axiom
	 * home); the store appends root-guard/<rootHash>/ below it.
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

/** B3 reason: destructive binary with the filesystem root as an operand. */
function destructiveBareRootBlock(bin: string): { block: true; reason: string } {
	return {
		block: true,
		reason:
			`Refusing to run '${bin}' with the filesystem root ('/') as an operand. ` +
			`This command can destroy or expose system-wide data, and the root path can never be ` +
			`approved through request_root_access. Only the operator can run this from their own terminal.`,
	};
}

/** B2b reason: obfuscation markers with no judgeable inside path. */
function obfuscationBlock(markers: readonly string[]): { block: true; reason: string } {
	return {
		block: true,
		reason:
			`Refusing to run this cell: it spells paths through shell/python obfuscation ` +
			`(${markers.join(", ")}) the root guard cannot safely resolve, and it names no path ` +
			`inside the project root. Rewrite the cell with literal path strings, or call ` +
			`request_root_access with the plain paths and a short reason.`,
	};
}

const MAX_REQUEST_PATHS = 64;

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
		// resolveScopeDir appends the root-guard segment below the state dir,
		// so the layout is <stateDir>/root-guard/<rootHash>/. The default is
		// the OPERATOR-OWNED /var/lib/axiom-root-guard — never the axiom home.
		const stateDir = options.stateDir ?? process.env.AXIOM_ROOT_GUARD_STATE_DIR ?? defaultRootGuardStateDir();
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
		// The store is operator-owned (ADR-0052 hardening): its dirs and the
		// legacy axiom-home store are hard-denied on every seam, resolved by
		// realpath too, so no allow prefix or grant can ever unblock them.
		let stateDeniesPromise: Promise<string[]> | undefined;
		const stateDenies = (): Promise<string[]> => {
			stateDeniesPromise ??= buildStateDenies(stateDir, join(axiomHome(), "root-guard"));
			return stateDeniesPromise;
		};
		const operatorCommand = (id: string, verb: "approve" | "reject" = "approve"): string =>
			`axiom root-guard ${verb} ${id} --root ${shellQuote(rawRoot)}` +
			(customStateDir ? ` --state-dir ${shellQuote(customStateDir)}` : "");

		pi.on("tool_call", async (event) => {
			const text = shellText(event.toolName, event.input);
			if (text === undefined) return undefined;

			// B3: destructive coreutils with a bare-root operand (the F2
			// family: a trailing word defeats the tokenizer's bare-root
			// lookahead, so the shell command is judged as a whole).
			if (event.toolName === "bash") {
				const bin = checkDestructiveBareRoot(text);
				if (bin) return destructiveBareRootBlock(bin);
			} else if (event.toolName === "ipython") {
				const bin = checkDestructiveBareRoot(shellLinesOfCode(text));
				if (bin) return destructiveBareRootBlock(bin);
			}

			// B1 step 1: cd/chdir through a variable or environment target can
			// drift the kernel cwd outside the root with no judgeable token.
			const drift = findCdDrift(text);
			if (drift) {
				return {
					block: true,
					reason:
						`Refusing to change directory with a variable or environment target (${drift[0]}). ` +
						`The working directory must stay inside the project root (${rawRoot}). ` +
						`Use a literal path inside the root, or call request_root_access for a specific outside directory.`,
				};
			}

			// B2a: decode shell-escaped slashes and ANSI-C $'...' quoting so
			// those spellings extract their real path and face the scope gate.
			const decoded = decodeShellEscapes(text);
			const tokens = extractCandidatePaths(decoded);
			const markers = findObfuscationMarkers(text);

			// B2b: chr(47)/chr(0x2f)/... spells the slash itself — block
			// regardless of what else the cell names.
			if (markers.includes("slash-chr")) return obfuscationBlock(markers);
			// B2b: ipython home/environment composition near a path token or a
			// quoted slash string (Path.home().joinpath('.ssh/...'), os.environ
			// + '/x', ...) fails closed — the token resolves against an
			// outside base the extractor cannot see.
			if (event.toolName === "ipython" && markers.includes("home-env-ref")) {
				if (tokens.length > 0 || hasQuotedSlashString(text)) {
					return obfuscationBlock(markers);
				}
			}
			// B2b: a cell with HARD obfuscation markers and NO known-inside
			// token fails closed (the residual the decoder cannot resolve).
			// SOFT markers (chr/codecs/import/home-env tricks) fail closed
			// only when a path context exists — env introspection without one
			// stays usable.
			if (tokens.length === 0) {
				if (hasHardMarker(markers)) return obfuscationBlock(markers);
				if (hasSoftMarker(markers) && hasQuotedSlashString(text)) return obfuscationBlock(markers);
				return undefined;
			}
			if (hasSoftMarker(markers)) return obfuscationBlock(markers);
			// Static policy first: inside-root (and policy-allowed) calls never
			// touch the approval store, so a broken store cannot block them.
			// The operator-owned store is hard-denied here too.
			const denied = [...(await stateDenies()), ...denyPrefixes];
			const decision = checkPathScope({
				root: rawRoot,
				cwd,
				home,
				paths: tokens,
				allowPrefixes,
				denyPrefixes: denied,
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
						`Fix AXIOM_ROOT_GUARD_STATE_DIR (default: ${defaultRootGuardStateDir()}, operator-provisioned) and retry.`,
				};
			}
			const withGrants = checkPathScope({
				root: rawRoot,
				cwd,
				home,
				paths: tokens,
				allowPrefixes: [...allowPrefixes, ...grants],
				denyPrefixes: denied,
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
			// block with a raw store error — the block still stands. Report the
			// POST-grant decision: it names exactly the still-blocked paths, so
			// the reason and the audit never over-name grant-allowed tokens.
			try {
				await appendAudit(scope, { event: "block", tool: event.toolName, paths: withGrants.paths });
			} catch {
				/* audit degraded; the block reason still reaches the model */
			}
			return { block: true, reason: withGrants.reason };
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
				const homeAbs = resolve(home);
				const axiomAbs = resolve(axiomHome());
				const absPaths = params.paths.map((p) => resolve(toAbsolutePath(p, cwd, home)));
				// BREADTH (hardening): the filesystem root, the operator's home,
				// and the axiom home can never be granted through a
				// model-initiated request — only the operator CLI touches them
				// directly. An accidental approve of "/" must not grant
				// everything forever.
				const isOverBroad = (p: string): boolean =>
					p === "/" || isWithinPath(homeAbs, p) || isWithinPath(axiomAbs, p);
				const overBroad = absPaths.filter((p) => !isWithinPath(rootAbs, p) && isOverBroad(p));
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
				const requestable = absPaths.filter(
					(p) => !isWithinPath(rootAbs, p) && !deniedByOperator.includes(p) && !overBroad.includes(p),
				);
				if (requestable.length > MAX_REQUEST_PATHS) {
					return {
						content: [
							{
								type: "text",
								text:
									`Refusing to file a request for ${requestable.length} paths: ` +
									`narrow it to at most ${MAX_REQUEST_PATHS} paths at a time.`,
							},
						],
						details: null,
					};
				}
				if (requestable.length === 0 && deniedByOperator.length === 0 && overBroad.length === 0) {
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
				if (requestable.length === 0 && overBroad.length > 0 && deniedByOperator.length === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									`Refusing to file a request for ${overBroad.join(", ")}: the filesystem root, ` +
									`the operator's home, and the axiom home are off-limits to model-initiated ` +
									`requests. Only the operator can touch these directly — no request_root_access ` +
									`approval is possible for them.`,
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
									`${deniedByOperator.join(", ")}. Do not request them again — find another way.` +
									(overBroad.length > 0
										? ` The operator's home and the filesystem root are off-limits to model ` +
											`requests, so these were dropped: ${overBroad.join(", ")}.`
										: ""),
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
				const broadNote =
					overBroad.length > 0
						? ` The operator's home and the filesystem root are off-limits to model requests, so ` +
							`these paths were dropped: ${overBroad.join(", ")}. Only the operator can touch them directly.`
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
							// The CLI wrote the SIGNED grant at approve time (the
							// agent never writes grants or decisions — the store
							// is operator-owned and HMAC-signed). Report and let
							// the retry prove the grant.
							return {
								content: [
									{
										type: "text",
										text:
											`The operator approved request ${id} for: ${requestable.join(", ")}. ` +
											`Retry the blocked call now — the guard allows these paths.${deniedNote}${broadNote}`,
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
										`${requestable.join(", ")}. Find another way or stop.${deniedNote}${broadNote}`,
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
										`'${operatorCommand(id, "reject")}'; an approval applies to later calls.${deniedNote}${broadNote}`,
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
										`calls automatically — retry the blocked call after it.${deniedNote}${broadNote}`,
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
