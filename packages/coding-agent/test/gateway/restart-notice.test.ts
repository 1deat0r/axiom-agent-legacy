import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FileRestartNoticeStore,
	InMemoryRestartNoticeStore,
	restartNoticePath,
} from "../../src/gateway/restart-notice.js";

describe("restartNoticePath", () => {
	it("lives under <home>/gateway", () => {
		expect(restartNoticePath("/x")).toBe(join("/x", "gateway", "restart-notice.json"));
	});
});

describe("FileRestartNoticeStore", () => {
	it("writes, reads-and-clears exactly once, then returns undefined", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-notice-"));
		try {
			const store = new FileRestartNoticeStore(join(dir, "restart-notice.json"));
			expect(store.readAndClear()).toBeUndefined();
			store.write({ sha: "abc12345", channelId: "119" });
			expect(store.readAndClear()).toEqual({ sha: "abc12345", channelId: "119" });
			expect(store.readAndClear()).toBeUndefined(); // cleared
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("InMemoryRestartNoticeStore", () => {
	it("round-trips and clears", () => {
		const store = new InMemoryRestartNoticeStore();
		store.write({ sha: "x", channelId: "y" });
		expect(store.readAndClear()).toEqual({ sha: "x", channelId: "y" });
		expect(store.readAndClear()).toBeUndefined();
	});
});
