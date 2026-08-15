/**
 * Axiom profile boot-seam regression test (ADR-0014 on the prime-agent v0.7.2
 * baseline). Pins the two restart-specific risks the external review called out:
 *  - the CLI pre-scan `readProfileFlag` (the `--profile` boot seam that must
 *    run before config resolution),
 *  - the env-var rename PI_CODING_AGENT_DIR -> AXIOM_CODING_AGENT_DIR,
 *    so profile isolation cannot silently break (a var the baseline never reads).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { AXIOM_HOME_ENV, resolveProfile } from "../../src/extensions/profile/registry.js";
import { readProfileFlag } from "../../src/main.js";

describe("profile boot pre-scan (readProfileFlag)", () => {
	it("returns the profile name for --profile <name>", () => {
		expect(readProfileFlag(["--profile", "work"])).toBe("work");
		expect(readProfileFlag(["run", "--profile", "client-a"])).toBe("client-a");
	});

	it("returns undefined when no --profile is present", () => {
		expect(readProfileFlag(["run"])).toBeUndefined();
		expect(readProfileFlag([])).toBeUndefined();
	});

	it("exits with an error when --profile has no value", () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});
		expect(() => readProfileFlag(["--profile"])).toThrow("process.exit called");
		exit.mockRestore();
	});
});

describe("env-var contract (the v0.7.2 rename)", () => {
	it("the legend and code agree that the agent-dir env var is AXIOM_*", () => {
		// The boot seam sets process.env[ENV_AGENT_DIR]; the baseline derives it
		// from the package config name. If it ever regressed to PI_CODING_AGENT_DIR,
		// profiles would silently all share the default home.
		expect(ENV_AGENT_DIR).toBe("AXIOM_CODING_AGENT_DIR");
	});

	it("resolveProfile homes a named profile and points the agent dir there", () => {
		const env: Record<string, string> = {};
		const { axiomHome, agentDir } = resolveProfile("work", env);
		expect(axiomHome).toBe(join(homedir(), ".axiom", "profiles", "work"));
		expect(agentDir).toBe(axiomHome);
		// the axiom home the extensions read is the profile's home
		const bootEnv: Record<string, string> = {};
		bootEnv[AXIOM_HOME_ENV] = axiomHome;
		const r2 = resolveProfile(undefined, bootEnv);
		expect(r2.axiomHome).toBe(axiomHome);
	});
});
