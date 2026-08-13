/**
 * Stream journal (streaming v2, ADR-0004/#6): persists in-flight stream
 * bubbles so a gateway restart can recover them. The placeholder ("…") bubble
 * is the only artifact a crashed stream leaves behind; without a journal it
 * sits there silently forever. On boot, stale records are edited into an
 * interruption notice so the operator never stares at a frozen ellipsis.
 *
 * JSONL append file under the gateway dir (single writer, tolerant of partial
 * or malformed lines) — the same shape as the delivery ledger (ADR-0022).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayTransport } from "./types.js";

/** One in-flight stream bubble (a placeholder awaiting its edits). */
export interface StreamRecord {
	/** The chat the bubble was placed in. */
	channelId: string;
	/** The platform message id of the bubble. */
	messageId: number;
	/** Epoch ms when the bubble was placed. */
	startedAt: number;
}

/** The journal surface the gateway writes in-flight streams through. */
export interface StreamJournal {
	add(record: StreamRecord): void;
	remove(channelId: string, messageId: number): void;
	load(): StreamRecord[];
	clear(): void;
}

/** Cap on persisted records so a pathological file never grows unbounded. */
const RECORD_CAP = 100;

/** JSONL stream journal under the gateway dir (single writer, best-effort). */
export class FileStreamJournal implements StreamJournal {
	constructor(
		private readonly path: string,
		private readonly logger: (line: string) => void = (line) => console.error(line),
	) {}

	private read(): StreamRecord[] {
		try {
			const raw = readFileSync(this.path, "utf8");
			const records: StreamRecord[] = [];
			for (const line of raw.split("\n")) {
				if (line.trim().length === 0) continue;
				try {
					const parsed = JSON.parse(line) as Partial<StreamRecord>;
					if (typeof parsed.channelId === "string" && typeof parsed.messageId === "number") {
						records.push({
							channelId: parsed.channelId,
							messageId: parsed.messageId,
							startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
						});
					}
				} catch {
					// Skip a malformed line; the rest of the journal is still readable.
				}
			}
			return records;
		} catch {
			return []; // Missing file -> no in-flight streams (self-repairing).
		}
	}

	private write(records: StreamRecord[]): void {
		try {
			const body = records.length > 0 ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
			writeFileSync(this.path, body, "utf8");
		} catch (error) {
			this.logger(`stream journal write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	add(record: StreamRecord): void {
		const records = this.read().filter(
			(r) => !(r.channelId === record.channelId && r.messageId === record.messageId),
		);
		records.push(record);
		if (records.length > RECORD_CAP) records.splice(0, records.length - RECORD_CAP);
		this.write(records);
	}

	remove(channelId: string, messageId: number): void {
		const records = this.read();
		const next = records.filter((r) => !(r.channelId === channelId && r.messageId === messageId));
		if (next.length !== records.length) this.write(next);
	}

	load(): StreamRecord[] {
		return this.read();
	}

	clear(): void {
		this.write([]);
	}
}

/** The journal file under the gateway dir (mirrors the delivery ledger's home). */
export function streamJournalPath(axiomHomeDir: string): string {
	return join(axiomHomeDir, "gateway", "streams.jsonl");
}

/** The notice a recovered bubble is edited to show (then the record is dropped). */
export const INTERRUPTED_STREAM_NOTICE =
	"⚠️ My previous reply was interrupted by a restart — send your message again and I'll re-run it.";

/**
 * Boot recovery: edit every stale in-flight bubble into an interruption notice
 * so a restart never leaves a silent "…" behind. One quick retry per record,
 * then the record is dropped either way (a dead bubble must not pin the boot
 * path); failures are logged for the operator.
 */
export async function recoverInterruptedStreams(
	transport: GatewayTransport,
	journal: StreamJournal,
	logger: (line: string) => void = (line) => console.error(line),
): Promise<void> {
	const records = journal.load();
	if (records.length === 0) return;
	const editMessage = transport.editMessage?.bind(transport);
	if (!editMessage) {
		// The active transport cannot edit bubbles in place (e.g. signal):
		// nothing to recover — drop the records so they never pile up.
		journal.clear();
		return;
	}
	for (const record of records) {
		let applied = false;
		for (let attempt = 0; attempt < 2 && !applied; attempt++) {
			try {
				await editMessage(record.channelId, record.messageId, INTERRUPTED_STREAM_NOTICE);
				applied = true;
			} catch {
				// Best-effort: one quick retry, then give up and drop the record.
			}
		}
		if (!applied) {
			logger(`stream recovery failed for chat ${record.channelId} message ${record.messageId}`);
		}
	}
	journal.clear();
}
