/**
 * `axiom peers` — see and talk to other axiom-agent instances working in the
 * same directory. Reads and writes exactly the same state as the agent-side
 * peers tools (same identity, same scope), so a human at the terminal and a
 * running agent coordinate through one channel.
 *
 * Returns true when the invocation was a peers command.
 */

import { randomUUID } from "node:crypto";
import {
	formatInbox,
	formatPeersList,
	listPeers,
	peekInbox,
	resolveInstanceId,
	resolvePeerScopeDir,
	sendPeerMessage,
} from "../core/peers/index.js";
import { axiomHome } from "../extensions/profile/registry.js";

export const PEERS_USAGE =
	"usage: axiom peers [list|inbox] | axiom peers msg <instance-id|*> <text> | axiom peers group <text>";

export async function handlePeersCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "peers") return false;
	const home = axiomHome();
	const root = process.env.AXIOM_PROJECT_ROOT ?? process.cwd();
	try {
		const identity = resolveInstanceId(home);
		const scope = resolvePeerScopeDir(root, home);
		const sub = args[1] ?? "list";
		switch (sub) {
			case "list": {
				console.log(formatPeersList(listPeers(scope, identity), identity.shortId));
				return true;
			}
			case "inbox": {
				console.log(formatInbox(peekInbox(scope, identity).messages));
				return true;
			}
			case "msg": {
				const to = args[2];
				const text = args.slice(3).join(" ");
				if (!to || text.trim() === "") {
					console.log(PEERS_USAGE);
					return true;
				}
				sendPeerMessage(scope, identity, `cli-${randomUUID()}`, to, text);
				console.log(to === "*" ? "sent to all peers (group)" : `sent to ${to.slice(0, 8)}`);
				return true;
			}
			case "group": {
				const text = args.slice(2).join(" ");
				if (text.trim() === "") {
					console.log(PEERS_USAGE);
					return true;
				}
				sendPeerMessage(scope, identity, `cli-${randomUUID()}`, "*", text);
				console.log("sent to all peers (group)");
				return true;
			}
			default: {
				console.log(PEERS_USAGE);
				return true;
			}
		}
	} catch (error) {
		process.stderr.write(`axiom peers: ${(error as Error).message}\n`);
		return true;
	}
}
