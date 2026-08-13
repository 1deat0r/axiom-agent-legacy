import { describe, expect, it } from "vitest";
import { parseProfileEditArgs } from "../src/cli/profile-command.js";
import { type ProfileEditFlowDeps, runProfileEditFlow } from "../src/modes/interactive/components/profile-edit-flow.js";

function makeDeps(overrides: Partial<ProfileEditFlowDeps> = {}): {
	deps: ProfileEditFlowDeps;
	calls: string[];
	spawned: Array<{ cmd: string; args: string[]; file: string }>;
} {
	const calls: string[] = [];
	const spawned: Array<{ cmd: string; args: string[]; file: string }> = [];
	const deps: ProfileEditFlowDeps = {
		listProfiles: async () => ["alpha", "beta"],
		resolveTarget: (_home, name, kind) => ({
			file: `/profiles/${name}/${kind === "soul" ? "SOUL.md" : "settings.json"}`,
		}),
		resolveEditor: () => ({ cmd: "vi", args: [] }),
		spawnEditor: (cmd, args, file) => {
			calls.push("spawn");
			spawned.push({ cmd, args, file });
			return { status: 0 };
		},
		ui: {
			stop: () => {
				calls.push("stop");
			},
			start: () => {
				calls.push("start");
			},
		},
		...overrides,
	};
	return { deps, calls, spawned };
}

describe("parseProfileEditArgs", () => {
	it("parses a plain edit request as the soul kind", () => {
		expect(parseProfileEditArgs("edit alice")).toEqual({ name: "alice", kind: "soul" });
	});

	it("parses the --settings flag as the settings kind", () => {
		expect(parseProfileEditArgs("edit alice --settings")).toEqual({ name: "alice", kind: "settings" });
	});

	it("returns undefined for non-edit invocations", () => {
		expect(parseProfileEditArgs("")).toBeUndefined();
		expect(parseProfileEditArgs("list")).toBeUndefined();
		expect(parseProfileEditArgs("--settings")).toBeUndefined();
	});
});

describe("runProfileEditFlow", () => {
	it("returns an error line for an unknown profile without touching the ui", async () => {
		const { deps, calls } = makeDeps();
		const line = await runProfileEditFlow("/home", "ghost", "soul", deps);
		expect(line).toContain("Unknown profile 'ghost'");
		expect(calls).toEqual([]);
	});

	it("stops the ui, runs the editor on the resolved file, then restarts", async () => {
		const { deps, calls, spawned } = makeDeps();
		const line = await runProfileEditFlow("/home", "alpha", "soul", deps);
		expect(line).toContain("edited 'alpha' SOUL.md");
		expect(line).toContain("/profiles/alpha/SOUL.md");
		expect(calls).toEqual(["stop", "spawn", "start"]);
		expect(spawned).toEqual([{ cmd: "vi", args: [], file: "/profiles/alpha/SOUL.md" }]);
	});

	it("restarts the ui even when the editor reports a non-zero exit", async () => {
		const { deps, calls } = makeDeps({
			spawnEditor: () => {
				calls.push("spawn");
				return { status: 1 };
			},
		});
		const line = await runProfileEditFlow("/home", "beta", "settings", deps);
		expect(line).toContain("editor exited with status 1");
		expect(calls).toEqual(["stop", "spawn", "start"]);
	});
});
