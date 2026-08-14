/**
 * Root guard approval store (ADR-0051) — file-backed request/decision state.
 *
 * Everything the approval loop needs lives under one scope directory,
 * root-scoped so two projects can never see each other's requests:
 *
 *   <stateDir>/root-guard/<rootHash>/
 *     pending/<id>.json     plain-English requests filed by the agent
 *     decisions/<id>.json   operator decisions (approve/reject), last-write-wins
 *     grants.jsonl          append-only approved path prefixes
 *     audit.jsonl           append-only block/request/decision/grant events
 *
 * Files, not a database: zero dependencies, survives crashes, and the
 * operator can inspect or hand-write a decision file if the CLI is not at
 * hand. Writes are atomic (tmp + rename) for records; grants and audit are
 * append-only JSONL.
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface PendingRequest {
	id: string;
	paths: string[];
	reason: string;
	status: "pending";
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

/** Stable absolute root: realpath when it exists, lexical resolve otherwise. */
async function stableRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		return resolve(root);
	}
}

/** The per-root scope directory, created on demand. */
export async function resolveScopeDir(stateDir: string, root: string): Promise<string> {
	const stable = await stableRoot(root);
	const hash = createHash("sha256").update(stable).digest("hex").slice(0, 12);
	const dir = join(stateDir, "root-guard", hash);
	await mkdir(dir, { recursive: true });
	return dir;
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

async function readJsonLines<T>(file: string): Promise<T[]> {
	try {
		const text = await readFile(file, "utf8");
		return text
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as T);
	} catch {
		return [];
	}
}

/** File a pending approval request. Returns its id and file path. */
export async function fileRequest(
	scopeDir: string,
	request: { paths: string[]; reason: string; id?: string },
): Promise<{ id: string; path: string }> {
	const id = request.id ?? newRequestId();
	const record: PendingRequest = {
		id,
		paths: request.paths,
		reason: request.reason,
		status: "pending",
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

/** All pending requests, oldest first (deterministic tie-break by id). */
export async function listPending(scopeDir: string): Promise<PendingRequest[]> {
	const dir = join(scopeDir, "pending");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: PendingRequest[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const rec = await readJson<PendingRequest>(join(dir, name));
		if (rec) records.push(rec);
	}
	return records.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Record an operator decision (approve or reject). Last write wins. */
export async function writeDecision(
	scopeDir: string,
	id: string,
	decision: { approved: boolean; note?: string },
): Promise<void> {
	const record: DecisionRecord = { id, approved: decision.approved, note: decision.note, decidedAt: Date.now() };
	const decisionsDir = join(scopeDir, "decisions");
	await mkdir(decisionsDir, { recursive: true });
	await atomicWrite(join(decisionsDir, `${id}.json`), JSON.stringify(record, null, 2));
}

/** Read one decision, or undefined. */
export async function readDecision(scopeDir: string, id: string): Promise<DecisionRecord | undefined> {
	return readJson<DecisionRecord>(join(scopeDir, "decisions", `${id}.json`));
}

/** All decisions, newest first. */
export async function listDecisions(scopeDir: string): Promise<DecisionRecord[]> {
	const dir = join(scopeDir, "decisions");
	let names: string[] = [];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const records: DecisionRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const rec = await readJson<DecisionRecord>(join(dir, name));
		if (rec) records.push(rec);
	}
	return records.sort((a, b) => b.decidedAt - a.decidedAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));
}

/** Append an approved grant (its prefixes unblock future guarded calls). */
export async function appendGrant(
	scopeDir: string,
	grant: { id: string; prefixes: string[]; reason: string },
): Promise<void> {
	const record: GrantRecord = { id: grant.id, prefixes: grant.prefixes, reason: grant.reason, grantedAt: Date.now() };
	await appendFile(join(scopeDir, "grants.jsonl"), `${JSON.stringify(record)}\n`);
}

/** All approved path prefixes across every grant. */
export async function listGrantPrefixes(scopeDir: string): Promise<string[]> {
	const grants = await readJsonLines<GrantRecord>(join(scopeDir, "grants.jsonl"));
	return grants.flatMap((g) => g.prefixes);
}

/** Append one audit event. */
export async function appendAudit(scopeDir: string, event: AuditEvent): Promise<void> {
	await appendFile(join(scopeDir, "audit.jsonl"), `${JSON.stringify({ ts: Date.now(), ...event })}\n`);
}

/** All audit events, newest first. */
export async function listAudit(scopeDir: string): Promise<Array<AuditEvent & { ts: number }>> {
	const events = await readJsonLines<AuditEvent & { ts: number }>(join(scopeDir, "audit.jsonl"));
	return events
		.map((e, index) => ({ ...e, index }))
		.sort((a, b) => b.ts - a.ts || b.index - a.index)
		.map(({ index: _index, ...e }) => e);
}
