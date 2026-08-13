/**
 * Peers extension (ADR-0038) — agent-to-agent coordination.
 *
 * When a run is anchored by AXIOM_PROJECT_ROOT, this extension publishes the
 * run's presence (pid + model + intent + heartbeat), heartbeats on turn
 * boundaries, and registers four model-callable tools: peers_list (who else
 * is live here and what they are doing), peers_send (directed message, or
 * group chat via to="*"), peers_inbox (read unread peer messages), and
 * peers_intent (tell peers what this run is doing). Unread peer messages also
 * notify the user at turn start.
 *
 * Inert without a project root, exactly like the security fence and recall:
 * ordinary unanchored runs are unaffected.
 */

import { type Static, Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.js";
import {
	formatInbox,
	formatPeersList,
	heartbeatRun,
	inbox,
	listPeers,
	type PeersDeps,
	peekInbox,
	registerRun,
	resolveInstanceId,
	resolvePeerScopeDir,
	sendPeerMessage,
	setIntent,
	unregisterRun,
} from "../../core/peers/index.js";
import { axiomHome } from "../profile/registry.js";

const PeersSendSchema = Type.Object({
	/** Target instance ID (see peers_list), or "*" for a group message every live peer sees. */
	to: Type.String(),
	/** Message text (max 4000 chars). */
	text: Type.String(),
});
type PeersSendParams = Static<typeof PeersSendSchema>;

const PeersIntentSchema = Type.Object({
	/** Short description of what this run is doing, e.g. "on branch feat/x in .worktrees/x". */
	text: Type.String(),
});
type PeersIntentParams = Static<typeof PeersIntentSchema>;

const NoParamsSchema = Type.Object({});

export interface PeersExtensionOptions {
	/** Explicit project root (tests). Defaults to process.env.AXIOM_PROJECT_ROOT. */
	root?: string;
	/** Axiom home for identity + scope (tests). Defaults to the active axiom home. */
	homeDir?: string;
	/** Explicit scope dir (tests). Defaults to the project-root-derived scope. */
	scope?: string;
	/** Injectable clock, run id, stale threshold, and pid probe for tests. */
	now?: () => number;
	uuid?: () => string;
	staleMs?: number;
	pidAlive?: (pid: number) => boolean;
}

export function createPeersExtension(options: PeersExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) => {
		const rawRoot = options.root ?? process.env.AXIOM_PROJECT_ROOT;
		if (!rawRoot) return; // inert unless a project root is anchored
		const homeDir = options.homeDir ?? axiomHome();
		const identity = resolveInstanceId(homeDir);
		const scope = options.scope ?? resolvePeerScopeDir(rawRoot, homeDir);
		const deps: PeersDeps = {
			now: options.now,
			staleMs: options.staleMs,
			pidAlive: options.pidAlive,
			uuid: options.uuid,
		};
		let runId: string | undefined;

		const ensureRegistered = (model: string): void => {
			if (runId) return;
			runId = registerRun(scope, identity, { model }, deps);
		};
		const touch = (): void => {
			if (runId) heartbeatRun(scope, runId, deps);
		};
		const modelName = (ctx: { model?: { id?: string } | undefined }): string => ctx.model?.id ?? "";

		pi.registerTool({
			name: "peers_list",
			label: "List peer agents",
			description:
				"List other axiom-agent instances working in this same project directory: who is live " +
				"(active), who has gone quiet or crashed (stale), and what each says it is doing (intent). " +
				"Use this to see if other agents are working in the same directory before touching shared " +
				"state.",
			promptGuidelines: [
				"Before switching git branches, running git reset/clean, or otherwise mutating the shared " +
					"working tree, call peers_list to see which other instances are live and what they are " +
					"doing. Coordinate with peers_send before colliding on the same files or branches.",
			],
			parameters: NoParamsSchema,
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				ensureRegistered(modelName(ctx));
				return {
					content: [{ type: "text", text: formatPeersList(listPeers(scope, identity, deps), identity.shortId) }],
					details: null,
				};
			},
		});

		pi.registerTool({
			name: "peers_send",
			label: "Send a peer message",
			description:
				"Send a message to another agent instance working in this same project directory, or a " +
				"group message every live peer sees (the group chat). Use to coordinate: ask a peer to " +
				"hold off on commits, split work, or report status. Target is an instance ID from " +
				'peers_list, or "*" for everyone.',
			parameters: PeersSendSchema,
			execute: async (_toolCallId, params: PeersSendParams, _signal, _onUpdate, ctx) => {
				ensureRegistered(modelName(ctx));
				sendPeerMessage(scope, identity, runId ?? "", params.to, params.text, deps);
				const who = params.to === "*" ? "all live peers (group)" : params.to.slice(0, 8);
				return { content: [{ type: "text", text: `sent to ${who}` }], details: null };
			},
		});

		pi.registerTool({
			name: "peers_inbox",
			label: "Read peer messages",
			description:
				"Read unread messages from other agent instances working in this same project directory " +
				"(both messages sent directly to you and group messages). Marking them read. Check this " +
				"at the start of a turn and before mutating shared state.",
			parameters: NoParamsSchema,
			execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
				ensureRegistered(modelName(ctx));
				return {
					content: [{ type: "text", text: formatInbox(inbox(scope, identity).messages) }],
					details: null,
				};
			},
		});

		pi.registerTool({
			name: "peers_intent",
			label: "Set my peer intent",
			description:
				"Tell other agent instances what this run is doing right now (e.g. 'on branch feat/x " +
				"in worktree .worktrees/x, working on the board'). Peers see it in their peers_list. " +
				"Keep it current so instances coordinate instead of colliding.",
			parameters: PeersIntentSchema,
			execute: async (_toolCallId, params: PeersIntentParams, _signal, _onUpdate, ctx) => {
				ensureRegistered(modelName(ctx));
				const ok = setIntent(scope, runId ?? "", params.text, deps);
				return {
					content: [
						{
							type: "text",
							text: ok ? "intent recorded" : "(intent not recorded — run is not registered yet)",
						},
					],
					details: null,
				};
			},
		});

		pi.on("session_start", (_event, ctx) => {
			ensureRegistered(modelName(ctx as { model?: { id?: string } | undefined }));
			touch();
		});
		pi.on("turn_start", (_event, ctx) => {
			touch();
			if (ctx.hasUI) {
				const unread = peekInbox(scope, identity).messages;
				if (unread.length > 0) {
					ctx.ui.notify(`${unread.length} new peer message(s) — use peers_inbox to read`, "info");
				}
			}
		});
		pi.on("session_shutdown", () => {
			if (runId) {
				unregisterRun(scope, runId);
				runId = undefined;
			}
		});
	};
}

export default function axiomPeersExtension(pi: ExtensionAPI): void {
	createPeersExtension()(pi);
}
