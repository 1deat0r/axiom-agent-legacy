/**
 * Root guard approval store (ADR-0052 + "Hardening (2026-08-14)") —
 * file-backed request/decision state with HMAC-signed operator records.
 *
 * Everything the approval loop needs lives under one scope directory,
 * root-scoped so two projects can never see each other's requests:
 *
 *   <stateDir>/root-guard/<rootHash>/
 *     pending/<id>.json     plain-English requests filed by the agent
 *     decisions/<id>.json   operator decisions (approve/reject), SIGNED
 *     grants.jsonl          approved path prefixes, every line SIGNED
 *     audit.jsonl           block/request/grant-use (agent, unsigned) and
 *                           decision/grant (operator, signed) events
 *     .hmac-key             HMAC key, mode 0600, created ONLY by the CLI
 *
 * Files, not a database: zero dependencies, survives crashes, and the
 * operator can inspect the board with the CLI. Writes are atomic
 * (tmp + rename) for records; grants and audit are JSONL.
 *
 * HARDENING (B1 self-approval): grants and decisions are signed with an
 * HMAC key the agent process never creates. The guard verifies every
 * signature on read and treats unsigned/invalid entries as ABSENT, so an
 * agent-written forgery can never become an allow. The agent-side audit
 * events are advisory (writer: "agent"); the operator's decision and
 * grant events are the signed record. The key file lives inside the
 * scope dir, which the guard hard-denies on the tool seam; OS-level
 * separation (a different uid for the operator's store) remains the
 * ADR-0019 strict tier.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	stat as statFile,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PendingRequest {
	id: string;
	paths: string[];
	reason: string;
	createdAt: number;
}

export interface DecisionRecord {
	id: string;
	approved: boolean;
	note?: string;
	decidedAt: number;
}

export interface GrantRecord {
	id: string;
	prefixes: string[];
	reason: string;
	grantedAt: number;
}

export type AuditEvent = { event: string } & Record<string, unknown>;

/** The operator-owned default (ADR-0052 hardening): outside the agent's
 *  reachable namespace, never under the axiom home or the project root. */
export const DEFAULT_ROOT_GUARD_STATE_DIR = "/var/lib/axiom-root-guard";

export function defaultRootGuardStateDir(): string {
	return DEFAULT_ROOT_GUARD_STATE_DIR;
}

/** Stable absolute root: realpath when it exists, lexical resolve otherwise. */
async function stableRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		return resolve(root);
	}
}

/** The per-root scope directory, created on demand (mode 0700 best-effort). */
export async function resolveScopeDir(stateDir: string, root: string): Promise<string> {
	const stable = await stableRoot(root);
	const hash = createHash("sha256").update(stable).digest("hex").slice(0, 12);
	const dir = join(stateDir, "root-guard", hash);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/**
 * Paths the guard hard-denies (win over allows AND grants): the configured
 * state dir and the legacy axiom-home store, each lexically AND realpath
 * resolved, so the obfuscation seam cannot reach the store either.
 */
export async function buildStateDenies(stateDir: string, legacyDir: string): Promise<string[]> {
	const denies = new Set<string>([resolve(stateDir), resolve(legacyDir)]);
	for (const dir of [stateDir, legacyDir]) {
		try {
			denies.add(await realpath(dir));
		} catch {
			/* absent — the lexical entry stands */
		}
	}
	return [...denies];
}

/** Request id: `rg-<millis base36>-<4 hex chars>`. */
export function newRequestId(now = Date.now(), rand = randomBytes(2).toString("hex")): string {
	return `rg-${now.toString(36)}-${rand}`;
}

async function atomicWrite(file: string, data: string): Promise<void> {
	const tmp = `${file}.tmp`;
	await writeFile(tmp, data);
	await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Raw non-empty text lines of a file ([] when absent). */
async function readRawLines(file: string): Promise<string[]> {
	try {
		return (await readFile(file, "utf8")).split("\n").filter((l) => l.trim().length > 0);
	} catch {
		return [];
	}
}

// ---- HMAC signing (ADR-0052 hardening) ----

/** The key file inside a scope dir (mode 0600; created ONLY by the CLI). */
function keyFile(scopeDir: string): string {
	return join(scopeDir, ".hmac-key");
}

/**
 * Load the scope's HMAC key, creating it on first use. This is the CLI's
 * path — the guard never calls it, so the agent process never materializes
 * a key it could use to forge records.
 */
export async function loadOrCreateKey(scopeDir: string): Promise<Buffer> {
	await mkdir(scopeDir, { recursive: true, mode: 0o700 });
	const file = keyFile(scopeDir);
	try {
		return Buffer.from((await readFile(file, "utf8")).trim(), "hex");
	} catch {
		/* absent — create */
	}
	const key = randomBytes(32);
	await writeFile(file, key.toString("hex"), { mode: 0o600 });
	return key;
}

/** Read-only key load for the guard: no key means no grants, fail-closed. */
async function loadKey(scopeDir: string): Promise<Buffer | undefined> {
	try {
		return Buffer.from((await readFile(keyFile(scopeDir), "utf8")).trim(), "hex");
	} catch {
		return undefined;
	}
}

/** HMAC-SHA256 over the canonical JSON of the record. */
export function signRecord(key: Buffer, record: unknown): string {
	return createHmac("sha256", key).update(JSON.stringify(record)).digest("hex");
}

/** Constant-time signature check. */
export function verifyRecord(key: Buffer, record: unknown, sig: string): boolean {
	if (typeof sig !== "string" || sig.length !== 64) return false;
	try {
		return timingSafeEqual(Buffer.from(signRecord(key, record), "hex"), Buffer.from(sig, "hex"));
	} catch {
		return false;
	}
}

interface SignedLine<T> {
	record: T;
	sig: string;
}

function parseSigned<T>(line: string): SignedLine<T> | undefined {
	try {
		const parsed = JSON.parse(line) as { record?: T; sig?: unknown };
		if (typeof parsed !== "object" || parsed === null) return undefined;
		if (!("record" in parsed) || !("sig" in parsed)) return undefined;
		if (typeof parsed.sig !== "string") return undefined;
		return { record: parsed.record as T, sig: parsed.sig };
	} catch {
		return undefined;
	}
}

/**
 * Remove `*.tmp` debris older than the threshold from `pending/` and
 * `decisions/`. Atomic writes (tmp + rename) can leave a `.tmp` file behind
 * on a crash; readers filter `.json` so the debris is invisible but
 * accumulates. Swept on board reads and before filing — the
 * operator-facing surfaces, not every gate call.
 */
export async function sweepStaleTmp(scopeDir: string, maxAgeMs = 3_600_000): Promise<void> {
	const cutoff = Date.now() - maxAgeMs;
	for (const sub of ["pending", "decisions"]) {
		const dir = join(scopeDir, sub);
		let names: string[] = [];
		try {
			names = await readdir(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			if (!name.endsWith(".tmp")) continue;
			const file = join(dir, name);
			try {
				const st = await statFile(file);
				if (st.mtimeMs < cutoff) await unlink(file);
			} catch {
				/* raced with another writer — leave it */
			}
		}
	}
}

/** File a pending approval request. Returns its id and file path. */
export async function fileRequest(
	scopeDir: string,
	request: { paths: string[]; reason: string; id?: string },
): Promise<{ id: string; path: string }> {
	await sweepStaleTmp(scopeDir);
	const id = request.id ?? newRequestId();
	const record: PendingRequest = {
		id,
		paths: request.paths,
		reason: request.reason,
		createdAt: Date.now(),
	};
	const pendingDir = join(scopeDir, "pending");
	await mkdir(pendingDir, { recursive: true });
	const path = join(pendingDir, `${id}.json`);
	await atomicWrite(path, JSON.stringify(record, null, 2));
	return { id, path };
}

/** Read one pending request, or undefined. */
export async function readPending(scopeDir: string, id: string): Promise<PendingRequest | undefined> {
	return readJson<PendingRequest>(join(scopeDir, "pending", `${id}.json`));
}

/**
 * All UNDECIDED requests, oldest first (deterministic tie-break by id).
 * A request with a decision file leaves the pending board — the decision
 * history itself stays visible via listDecisions.
 */
export async function listPending(scopeDir: string): Promise<PendingRequest[]> {
	await sweepStaleTmp(scopeDir);
	const dir = join(scopeDir, "pending");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const decided = new Set(await decisionIds(scopeDir));
	const records: PendingRequest[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -".json".length);
		if (decided.has(id)) continue;
		const rec = await readJson<PendingRequest>(join(dir, name));
		if (rec) records.push(rec);
	}
	return records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Ids of every recorded decision (used to drain the pending board). */
async function decisionIds(scopeDir: string): Promise<string[]> {
	let names: string[] = [];
	try {
		names = await readdir(join(scopeDir, "decisions"));
	} catch {
		return [];
	}
	return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
}

/** Record an operator decision (approve or reject). Last write wins. SIGNED. */
export async function writeDecision(
	scopeDir: string,
	id: string,
	decision: { approved: boolean; note?: string },
): Promise<void> {
	const record: DecisionRecord = { id, approved: decision.approved, note: decision.note, decidedAt: Date.now() };
	const key = await loadOrCreateKey(scopeDir);
	const decisionsDir = join(scopeDir, "decisions");
	await mkdir(decisionsDir, { recursive: true });
	await atomicWrite(join(decisionsDir, `${id}.json`), JSON.stringify({ record, sig: signRecord(key, record) }));
}

/**
 * Read one decision, or undefined. UNSIGNED or invalid files are treated as
 * absent (fail closed): a forged decision can never flip a block to allow.
 */
export async function readDecision(scopeDir: string, id: string): Promise<DecisionRecord | undefined> {
	const key = await loadKey(scopeDir);
	if (!key) return undefined;
	const file = join(scopeDir, "decisions", `${id}.json`);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseSigned<DecisionRecord>(raw);
	if (!parsed) return undefined;
	if (!verifyRecord(key, parsed.record, parsed.sig)) return undefined;
	return parsed.record;
}

/** All decisions, newest first, each with its signature verification. */
export async function listDecisions(scopeDir: string): Promise<Array<DecisionRecord & { verified: boolean }>> {
	await sweepStaleTmp(scopeDir);
	const dir = join(scopeDir, "decisions");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const key = await loadKey(scopeDir);
	const records: Array<DecisionRecord & { verified: boolean }> = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let raw: string;
		try {
			raw = await readFile(join(dir, name), "utf8");
		} catch {
			continue;
		}
		const line = parseSigned<DecisionRecord>(raw);
		if (!line) continue;
		records.push({ ...line.record, verified: key ? verifyRecord(key, line.record, line.sig) : false });
	}
	return records.sort((a, b) => b.decidedAt - a.decidedAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
}

/** Append an approved grant (its prefixes unblock future guarded calls). SIGNED. */
export async function appendGrant(
	scopeDir: string,
	grant: { id: string; prefixes: string[]; reason: string },
): Promise<void> {
	const record: GrantRecord = { id: grant.id, prefixes: grant.prefixes, reason: grant.reason, grantedAt: Date.now() };
	const key = await loadOrCreateKey(scopeDir);
	await appendFile(join(scopeDir, "grants.jsonl"), `${JSON.stringify({ record, sig: signRecord(key, record) })}\n`);
}

/** Verified grant records only (unsigned lines are inert). */
async function readVerifiedGrants(scopeDir: string): Promise<GrantRecord[]> {
	const key = await loadKey(scopeDir);
	if (!key) return [];
	const lines = await readRawLines(join(scopeDir, "grants.jsonl"));
	const out: GrantRecord[] = [];
	for (const line of lines) {
		const parsed = parseSigned<GrantRecord>(line);
		if (!parsed) continue;
		if (verifyRecord(key, parsed.record, parsed.sig)) out.push(parsed.record);
	}
	return out;
}

/**
 * Append a grant only when no VERIFIED grant with the same request id
 * exists yet, and return whether this call appended. This is the CLI's
 * approve path (the agent never writes grants — the guard reads them).
 * When it appends, it also writes the signed "grant" audit event — one
 * writer, one event, so the audit never double-records an approval.
 */
export async function appendGrantIfMissing(
	scopeDir: string,
	grant: { id: string; prefixes: string[]; reason: string },
): Promise<boolean> {
	const existing = await readVerifiedGrants(scopeDir);
	if (existing.some((g) => g.id === grant.id)) return false;
	await appendGrant(scopeDir, grant);
	await appendSignedAudit(scopeDir, { event: "grant", id: grant.id, prefixes: grant.prefixes });
	return true;
}

/**
 * All VERIFIED approved path prefixes across every grant, deduped.
 * Unsigned/tampered lines are treated as absent — the agent cannot forge
 * an allow, even with write access to the store files.
 */
export async function listGrantPrefixes(scopeDir: string): Promise<string[]> {
	const grants = await readVerifiedGrants(scopeDir);
	return [...new Set(grants.flatMap((g) => g.prefixes))];
}

/** Append one AGENT-written audit event (advisory, unsigned). */
export async function appendAudit(scopeDir: string, event: AuditEvent): Promise<void> {
	await appendFile(
		join(scopeDir, "audit.jsonl"),
		`${JSON.stringify({ ts: Date.now(), writer: "agent", ...event })}\n`,
	);
}

/** Append one OPERATOR audit event (the signed record of decisions/grants). */
export async function appendSignedAudit(scopeDir: string, event: AuditEvent): Promise<void> {
	const record: AuditEvent & { ts: number; writer: string } = {
		ts: Date.now(),
		writer: "operator",
		...event,
	};
	const key = await loadOrCreateKey(scopeDir);
	await appendFile(join(scopeDir, "audit.jsonl"), `${JSON.stringify({ record, sig: signRecord(key, record) })}\n`);
}

/**
 * All audit events, newest first. Signed operator entries carry
 * `verified: true` when their signature checks (and `false` when it does
 * not); agent-written entries are unsigned and have no `verified` flag.
 */
export async function listAudit(scopeDir: string): Promise<Array<AuditEvent & { ts: number; verified?: boolean }>> {
	const lines = await readRawLines(join(scopeDir, "audit.jsonl"));
	const key = await loadKey(scopeDir);
	const events: Array<AuditEvent & { ts: number; verified?: boolean; index: number }> = [];
	let index = 0;
	for (const line of lines) {
		const signed = parseSigned<AuditEvent & { ts: number }>(line);
		if (signed) {
			events.push({ ...signed.record, verified: key ? verifyRecord(key, signed.record, signed.sig) : false, index });
		} else {
			try {
				const plain = JSON.parse(line) as AuditEvent & { ts: number };
				events.push({ ...plain, index });
			} catch {
				/* skip malformed lines */
			}
		}
		index++;
	}
	return events.sort((a, b) => b.ts - a.ts || b.index - a.index).map(({ index: _index, ...e }) => e);
}
