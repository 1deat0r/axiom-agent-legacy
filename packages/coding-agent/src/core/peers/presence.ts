/**
 * Presence files: one JSON file per run under `<scope>/presence/<runId>.json`.
 * Liveness is heartbeat freshness plus pid existence, so a crashed process
 * goes stale on its own without any explicit unregister.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PresenceRecord } from "./types.js";

/** A peer with no heartbeat for this long is stale (not live). */
export const DEFAULT_STALE_MS = 5 * 60_000;

export interface PresenceDeps {
	mkdir?: (path: string) => void;
	writeFile?: (path: string, data: string) => void;
	rename?: (from: string, to: string) => void;
	readDir?: (path: string) => string[];
	readFile?: (path: string) => string;
	rm?: (path: string) => void;
	now?: () => number;
}

export function presenceFile(scope: string, runId: string): string {
	return join(scope, "presence", `${runId}.json`);
}

function writeAtomic(scope: string, record: PresenceRecord, deps: PresenceDeps): void {
	const writeFile = deps.writeFile ?? ((path, data) => writeFileSync(path, data, "utf8"));
	const rename = deps.rename ?? ((from, to) => renameSync(from, to));
	const mkdir = deps.mkdir ?? ((path) => mkdirSync(path, { recursive: true }));
	mkdir(join(scope, "presence"));
	const tmp = `${presenceFile(scope, record.runId)}.tmp`;
	writeFile(tmp, `${JSON.stringify(record)}\n`);
	rename(tmp, presenceFile(scope, record.runId));
}

/** Publish (or republish) a run's presence record. */
export function writePresence(scope: string, record: PresenceRecord, deps: PresenceDeps = {}): void {
	writeAtomic(scope, record, deps);
}

/**
 * Read-modify-write one run's presence record: find it, patch it, republish
 * it atomically. Returns false when the run has no record (gone or never
 * registered). The single shape behind heartbeat and intent updates.
 */
export function updatePresence(
	scope: string,
	runId: string,
	patch: Partial<PresenceRecord>,
	deps: PresenceDeps = {},
): boolean {
	const record = listPresence(scope, deps).find((r) => r.runId === runId);
	if (!record) return false;
	writeAtomic(scope, { ...record, ...patch }, deps);
	return true;
}

/** Bump a run's heartbeat. Returns false when the record is gone. */
export function heartbeatPresence(scope: string, runId: string, deps: PresenceDeps = {}): boolean {
	const now = deps.now ?? Date.now;
	return updatePresence(scope, runId, { heartbeatAt: new Date(now()).toISOString() }, deps);
}

/** List all presence records; malformed files are skipped, never fatal. */
export function listPresence(scope: string, deps: PresenceDeps = {}): PresenceRecord[] {
	const readDir =
		deps.readDir ??
		((path) => {
			try {
				return readdirSync(path);
			} catch {
				return [];
			}
		});
	const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
	const records: PresenceRecord[] = [];
	for (const name of readDir(join(scope, "presence")).sort()) {
		if (!name.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFile(join(scope, "presence", name))) as Partial<PresenceRecord>;
			if (
				typeof parsed.instanceId === "string" &&
				typeof parsed.runId === "string" &&
				typeof parsed.pid === "number" &&
				typeof parsed.startedAt === "string" &&
				typeof parsed.heartbeatAt === "string"
			) {
				records.push({
					instanceId: parsed.instanceId,
					runId: parsed.runId,
					pid: parsed.pid,
					model: typeof parsed.model === "string" ? parsed.model : "",
					intent: typeof parsed.intent === "string" ? parsed.intent : "",
					startedAt: parsed.startedAt,
					heartbeatAt: parsed.heartbeatAt,
				});
			}
		} catch {
			// Malformed presence line: skip.
		}
	}
	return records;
}

/** Liveness rule: pid exists AND heartbeat is fresh. */
export function isPeerAlive(
	record: PresenceRecord,
	nowMs: number,
	staleMs: number,
	pidAlive: (pid: number) => boolean,
): boolean {
	const age = nowMs - Date.parse(record.heartbeatAt);
	if (!Number.isFinite(age)) return false;
	return pidAlive(record.pid) && age < staleMs;
}

export function unregisterPresence(scope: string, runId: string, deps: PresenceDeps = {}): void {
	const rm = deps.rm ?? ((path) => rmSync(path, { force: true }));
	rm(presenceFile(scope, runId));
}
