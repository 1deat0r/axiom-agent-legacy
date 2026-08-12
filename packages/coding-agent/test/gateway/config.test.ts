import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGatewayConfig, isAllowedSender, loadGatewayConfig } from "../../src/gateway/config.js";

describe("gateway config", () => {
	it("defaults to an empty allowlist for a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-config-"));
		try {
			expect(loadGatewayConfig(dir)).toEqual(defaultGatewayConfig());
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("parses the deliverTo fan-out channels and defaults them empty otherwise", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-config-"));
		try {
			await mkdir(join(dir, "gateway"), { recursive: true });
			await writeFile(
				join(dir, "gateway", "config.json"),
				JSON.stringify({
					senders: ["U-OWNER"],
					deliverTo: [{ channel: "C1" }, { channel: "C2" }, { channel: 7 }],
				}),
			);
			const cfg = loadGatewayConfig(dir);
			expect(cfg.deliverTo).toEqual([{ channel: "C1" }, { channel: "C2" }]); // non-string dropped
			// Back-compat: a config with only senders has an empty deliverTo.
			await writeFile(join(dir, "gateway", "config.json"), JSON.stringify({ senders: ["+1"] }));
			expect(loadGatewayConfig(dir).deliverTo).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	it("loads the senders allowlist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-config-"));
		try {
			await mkdir(join(dir, "gateway"), { recursive: true });
			await writeFile(join(dir, "gateway", "config.json"), JSON.stringify({ senders: ["+15551234567"] }));
			const cfg = loadGatewayConfig(dir);
			expect(isAllowedSender(cfg, "+15551234567")).toBe(true);
			expect(isAllowedSender(cfg, "+19998887777")).toBe(false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
