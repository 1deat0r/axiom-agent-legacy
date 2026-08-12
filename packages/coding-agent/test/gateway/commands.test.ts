import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchCommand } from "../../src/gateway/commands/index.js";
import { defaultGatewayConfig, isAllowedSender } from "../../src/gateway/config.js";

function ctx(axiomHomeDir: string, profile = "default") {
	return { profile, axiomHomeDir, projectHome: join(axiomHomeDir, "profiles", profile) };
}

describe("command dispatch", () => {
	it("answers /help", () => {
		const out = dispatchCommand("/help", ctx("/tmp"));
		expect(out).toContain("/profiles");
		expect(out).toContain("/soul");
	});
	it("rejects an unknown command with a usage hint", () => {
		expect(dispatchCommand("/bogus x", ctx("/tmp"))).toContain("unknown command");
	});
});

describe("profiles command", () => {
	it("lists, creates, and switches profiles against a real home", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			expect(dispatchCommand("/profiles", ctx(dir))).toContain("no profiles");
			expect(dispatchCommand("/profiles create builder", ctx(dir))).toContain("created");
			expect(dispatchCommand("/profiles", ctx(dir))).toContain("builder");
			expect(dispatchCommand("/profiles switch builder", ctx(dir))).toContain(
				"restart `axiom gateway --profile builder`",
			);
			expect(dispatchCommand("/profiles switch nope", ctx(dir))).toContain("unknown profile");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("projects command", () => {
	it("adds, lists, removes projects on the active profile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			dispatchCommand("/profiles create w", ctx(dir));
			const c = ctx(dir, "w");
			expect(dispatchCommand("/projects add alpha", c)).toContain("added");
			expect(dispatchCommand("/projects", c)).toContain("alpha");
			expect(dispatchCommand("/projects rm alpha", c)).toContain("removed");
			expect(dispatchCommand("/projects", c)).toContain("no projects");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("soul command", () => {
	it("sets and views a profile's SOUL.md", async () => {
		const dir = await mkdtemp(join(tmpdir(), "axiom-gw-pm-"));
		try {
			dispatchCommand("/profiles create p", ctx(dir));
			expect(dispatchCommand("/soul p I am the PM builder.", ctx(dir))).toContain("updated");
			expect(dispatchCommand("/soul p", ctx(dir))).toContain("PM builder");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("allowlist (owner gate)", () => {
	it("isAllowedSender gates on the senders list", () => {
		const cfg = { senders: ["+1"] };
		expect(isAllowedSender(cfg, "+1")).toBe(true);
		expect(isAllowedSender(cfg, "+2")).toBe(false);
		expect(isAllowedSender(defaultGatewayConfig(), "+1")).toBe(false);
	});
});
