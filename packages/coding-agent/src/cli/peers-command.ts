/**
 * `axiom peers` — see and talk to other axiom-agent instances working in the
 * same directory. Reads and writes exactly the same state as the agent-side
 * peers tools (same identity, same scope), so a human at the terminal and a
 * running agent coordinate through one channel. Human output is rendered to
 * terminal standards (aligned columns, relative times, color that respects
 * TTY/NO_COLOR/FORCE_COLOR); --json gives scripts the raw records.
 *
 * Returns true when the invocation was a peers command.
 */

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { listPeers, peekInbox, resolveInstanceId, resolvePeerScopeDir, sendPeerMessage } from "../core/peers/index.js";
import { detectStyle, renderInbox, renderPeersList } from "../core/peers/render.js";
import { axiomHome } from "../extensions/profile/registry.js";

export const PEERS_HELP = `axiom peers — see and talk to other axiom-agent instances in this directory

usage:
  axiom peers                      list instances (live and stale)
  axiom peers inbox                read unread peer messages (peek only)
  axiom peers msg <id|*> <text>    send to one instance, or "*" for everyone
  axiom peers group <text>         group message every live peer sees

flags:
  --json    machine-readable output (list and inbox)
  --help    this help

state lives under ~/.axiom/peers/<project-hash>/; nothing is written into the repo.`;

export async function handlePeersCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "peers") return false;
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("help")) {
		console.log(PEERS_HELP);
		return true;
	}
	const json = rest.includes("--json");
	const sub = rest.find((a) => !a.startsWith("--")) ?? "list";
	const home = axiomHome();
	const root = process.env.AXIOM_PROJECT_ROOT ?? process.cwd();
	try {
		const identity = resolveInstanceId(home);
		const scope = resolvePeerScopeDir(root, home);
		switch (sub) {
			case "list": {
				const result = listPeers(scope, identity);
				if (json) {
					console.log(JSON.stringify(result, null, 2));
					return true;
				}
				console.log(
					renderPeersList(result, {
						selfShortId: identity.shortId,
						projectLabel: basename(root),
						unread: peekInbox(scope, identity).messages.length,
						style: detectStyle(),
					}),
				);
				return true;
			}
			case "inbox": {
				const { messages } = peekInbox(scope, identity);
				if (json) {
					console.log(JSON.stringify(messages, null, 2));
					return true;
				}
				console.log(renderInbox(messages, detectStyle()));
				return true;
			}
			case "msg": {
				const to = rest[1];
				const text = rest.slice(2).join(" ").trim();
				if (!to || text === "") {
					console.log(PEERS_HELP);
					return true;
				}
				sendPeerMessage(scope, identity, `cli-${randomUUID()}`, to, text);
				console.log(to === "*" ? "✓ sent to all peers (group)" : `✓ sent to ${to.slice(0, 8)}`);
				return true;
			}
			case "group": {
				const text = rest.slice(1).join(" ").trim();
				if (text === "") {
					console.log(PEERS_HELP);
					return true;
				}
				sendPeerMessage(scope, identity, `cli-${randomUUID()}`, "*", text);
				console.log("✓ sent to all peers (group)");
				return true;
			}
			default: {
				console.log(PEERS_HELP);
				return true;
			}
		}
	} catch (error) {
		process.stderr.write(`axiom peers: ${(error as Error).message}\n`);
		return true;
	}
}
