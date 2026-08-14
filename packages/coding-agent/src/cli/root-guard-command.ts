/**
 * `axiom root-guard` — the operator's side of the approval loop (ADR-0052).
 *
 * Reads and writes exactly the same state the agent-side request_root_access
 * tool uses, so a human at the terminal decides on the requests a running
 * agent filed: `list` shows the board, `approve <id>` grants the requested
 * paths (recorded in grants.jsonl + audit.jsonl), `reject <id>` denies them.
 * Human output is plain aligned lines; --json gives scripts the raw records.
 *
 * Returns true when the invocation was a root-guard command.
 */

import {
	appendAudit,
	appendGrantIfMissing,
	listDecisions,
	listPending,
	readDecision,
	readPending,
	resolveScopeDir,
	writeDecision,
} from "../core/root-guard/store.js";
import { axiomHome } from "../extensions/profile/registry.js";

export const ROOT_GUARD_HELP = `axiom root-guard — approve or reject root-guard escape requests (ADR-0052)

usage:
  axiom root-guard list                     pending requests and recent decisions
  axiom root-guard approve <id> [--note <text>]  grant the requested paths
  axiom root-guard reject <id> [--note <text>]  deny the request

flags:
  --root <path>       project root the request belongs to
                      (default: AXIOM_PROJECT_ROOT, then the current directory)
  --state-dir <path>  approval state root (default: AXIOM_ROOT_GUARD_STATE_DIR
                      or the axiom home)
  --json              machine-readable output (list)
  --help              this help

State lives under <state-dir>/root-guard/<project-hash>/; nothing is written
into the repo. Every decision lands in the append-only audit log.`;

/** Short age label for a millisecond timestamp. */
function age(ts: number): string {
	const delta = Date.now() - ts;
	if (delta < 45_000) return "just now";
	if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
	return `${Math.floor(delta / 86_400_000)}d ago`;
}

/** The value that follows a `--flag`, or undefined. */
function valueAfter(flags: string[], flag: string): string | undefined {
	const i = flags.indexOf(flag);
	if (i === -1 || i + 1 >= flags.length) return undefined;
	const next = flags[i + 1];
	return next.startsWith("--") ? undefined : next;
}

export async function handleRootGuardCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "root-guard") return false;
	const rest = args.slice(1);
	if (rest.includes("--help") || rest.includes("help")) {
		console.log(ROOT_GUARD_HELP);
		return true;
	}
	const json = rest.includes("--json");
	// Strip values consumed by --root/--state-dir/--note so a flag value can
	// never be misread as the positional request id ("approve --note ok <id>").
	const consumed = new Set<number>();
	for (const flag of ["--root", "--state-dir", "--note"]) {
		for (let i = 0; i < rest.length; i++) {
			if (rest[i] === flag && i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
				consumed.add(i + 1);
				i++; // skip the consumed value; the next flag occurrence still parses
			}
		}
	}
	const positional = rest.filter((a, index) => !a.startsWith("--") && !consumed.has(index));
	const sub = positional[0] ?? "list";
	const root = valueAfter(rest, "--root") ?? process.env.AXIOM_PROJECT_ROOT ?? process.cwd();
	const stateDir = valueAfter(rest, "--state-dir") ?? process.env.AXIOM_ROOT_GUARD_STATE_DIR ?? axiomHome();
	const scope = await resolveScopeDir(stateDir, root);

	switch (sub) {
		case "list": {
			const pending = await listPending(scope);
			const decisions = await listDecisions(scope);
			if (json) {
				console.log(JSON.stringify({ root, pending, decisions }, null, 2));
				return true;
			}
			console.log(`root guard board — ${root}`);
			if (pending.length === 0) console.log("no pending requests");
			for (const p of pending) {
				console.log(`PENDING  ${p.id}  ${p.paths.join(", ")}  —  ${p.reason}  (${age(p.createdAt)})`);
			}
			for (const d of decisions.slice(0, 10)) {
				console.log(
					`${d.approved ? "APPROVED" : "REJECTED"}  ${d.id}  ${d.note ? `(${d.note}) ` : ""}(${age(d.decidedAt)})`,
				);
			}
			return true;
		}
		case "approve":
		case "reject": {
			const id = positional[1];
			if (!id) {
				console.error(`usage: axiom root-guard ${sub} <id> [--note <text>]`);
				return true;
			}
			const request = await readPending(scope, id);
			if (!request) {
				console.error(`No pending request '${id}' for root ${root}.`);
				return true;
			}
			if (await readDecision(scope, id)) {
				console.error(
					`Request '${id}' was already decided. Decisions are final; file a new request for new paths.`,
				);
				return true;
			}
			const note = valueAfter(rest, "--note");
			const approved = sub === "approve";
			await writeDecision(scope, id, { approved, note });
			if (approved) {
				// appendGrantIfMissing records the grant AND its audit event
				// only when it appends — one approval, one audit event.
				await appendGrantIfMissing(scope, { id, prefixes: request.paths, reason: request.reason });
				console.log(`Approved ${id}: ${request.paths.join(", ")} — the guard now allows these paths.`);
			} else {
				await appendAudit(scope, { event: "decision", id, approved: false });
				console.log(`Rejected ${id}.${note ? ` Note: ${note}` : ""}`);
			}
			return true;
		}
		default: {
			console.log(ROOT_GUARD_HELP);
			return true;
		}
	}
}
