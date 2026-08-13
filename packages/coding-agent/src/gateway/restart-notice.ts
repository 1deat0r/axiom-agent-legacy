/**
 * Restart-notice store (ADR-0034 follow-up): before a self-update restarts the
 * gateway, the /update command records the target sha + the operator's channel;
 * the freshly-started gateway reads + clears it on boot and announces "back
 * online". Because the announcement is sent by the NEW process — not a helper
 * launched by the dying one — it can never be swept up by the cgroup kill that
 * accompanies the restart.
 *
 * Strictly erasable TypeScript, top-level imports only.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What to announce after a restart: the deployed sha and who to tell. */
export interface RestartNotice {
	sha: string;
	channelId: string;
}

/** Persistence boundary (tests inject an in-memory store). */
export interface RestartNoticeStore {
	write(notice: RestartNotice): void;
	readAndClear(): RestartNotice | undefined;
}

/** The notice file under the AXIOM gateway dir. */
export function restartNoticePath(axiomHomeDir: string): string {
	return join(axiomHomeDir, "gateway", "restart-notice.json");
}

/** Json-backed store; missing/malformed file reads as "nothing to announce". */
export class FileRestartNoticeStore implements RestartNoticeStore {
	constructor(private readonly path: string) {}
	write(notice: RestartNotice): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(notice), "utf8");
	}
	readAndClear(): RestartNotice | undefined {
		let notice: RestartNotice | undefined;
		try {
			const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RestartNotice>;
			if (typeof raw.sha === "string" && typeof raw.channelId === "string" && raw.sha && raw.channelId) {
				notice = { sha: raw.sha, channelId: raw.channelId };
			}
		} catch {
			return undefined;
		}
		try {
			rmSync(this.path, { force: true });
		} catch {
			/* best-effort clear; a leftover notice just re-announces on next boot */
		}
		return notice;
	}
}

/** In-memory store (tests). */
export class InMemoryRestartNoticeStore implements RestartNoticeStore {
	private value: RestartNotice | undefined;
	write(notice: RestartNotice): void {
		this.value = notice;
	}
	readAndClear(): RestartNotice | undefined {
		const v = this.value;
		this.value = undefined;
		return v;
	}
}
