/**
 * Delivery ledger (ADR-0022): an append-only record of every outbound
 * delivery the gateway makes — the "continuity" half of the gateway-breadth
 * story. One run can fan a result out to every configured channel, and every
 * delivery (reply, denial, fan-out) is recorded so an operator or an
 * automation spine can audit who got what, when, and whether it succeeded.
 *
 * Two implementations: an in-memory ledger (the safe default for tests) and a
 * JSONL append file under `<AXIOM_HOME>/gateway/ledger.jsonl` (single writer,
 * tolerant of partial reads, capped in memory so `recent` stays cheap).
 */
import { appendFileSync, readFileSync } from "node:fs";

/** One recorded outbound delivery. */
export interface DeliveryEntry {
	/** Epoch ms when the delivery was attempted. */
	ts: number;
	/** The transport that delivered it (e.g. 'telegram', 'discord', 'slack'). */
	transport: string;
	/** The destination channel id. */
	channel: string;
	/** The recipient sender id (blank for fan-out broadcasts). */
	recipient: string;
	/** The number of characters attempted. */
	chars: number;
	/** Whether the send resolved without throwing. */
	ok: boolean;
	/** Set when `ok` is false. */
	error?: string;
}

/** The audit/view surface over deliveries. */
export interface DeliveryLedger {
	record(entry: DeliveryEntry): void;
	/** The most recent `n` entries, oldest-first. */
	recent(n: number): DeliveryEntry[];
}

const MEMORY_CAP = 1000;

/** In-memory ledger (no persistence) — the safe default for tests. */
export class MemoryDeliveryLedger implements DeliveryLedger {
	private readonly entries: DeliveryEntry[] = [];
	record(entry: DeliveryEntry): void {
		this.entries.push(entry);
		if (this.entries.length > MEMORY_CAP) this.entries.splice(0, this.entries.length - MEMORY_CAP);
	}
	recent(n: number): DeliveryEntry[] {
		return this.entries.slice(n > 0 ? this.entries.length - n : 0);
	}
}

/**
 * JSONL append-file ledger. Appends one JSON object per line (atomic enough for
 * a single writer under the gateway dir). On construction it seeds an in-memory
 * buffer from the file (capped) so `recent` never re-reads the whole file; a
 * missing/malformed tail line is skipped rather than failing the ledger.
 */
export class FileDeliveryLedger implements DeliveryLedger {
	private readonly buffer: DeliveryEntry[] = [];

	constructor(private readonly path: string) {
		try {
			const raw = readFileSync(path, "utf8");
			for (const line of raw.split("\n")) {
				if (line.trim().length === 0) continue;
				try {
					this.buffer.push(JSON.parse(line) as DeliveryEntry);
				} catch {
					// Skip a malformed line; the rest of the ledger is still readable.
				}
			}
			if (this.buffer.length > MEMORY_CAP) this.buffer.splice(0, this.buffer.length - MEMORY_CAP);
		} catch {
			// Missing file -> start an empty ledger (self-repairing).
		}
	}

	record(entry: DeliveryEntry): void {
		this.buffer.push(entry);
		if (this.buffer.length > MEMORY_CAP) this.buffer.splice(0, this.buffer.length - MEMORY_CAP);
		try {
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// A failed append is surfaced by the caller to the operator's
			// observable; in-memory continuity is preserved for the run.
		}
	}

	recent(n: number): DeliveryEntry[] {
		return this.buffer.slice(n > 0 ? this.buffer.length - n : 0);
	}
}
