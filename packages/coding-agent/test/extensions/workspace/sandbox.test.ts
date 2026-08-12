import { describe, expect, it } from "vitest";
import {
	assembleProgramArgv,
	buildSandboxMountArgs,
	confinementEnv,
	DEFAULT_SHADOW_REL,
	defaultShadowDirs,
	resolveBwrap,
	resolveConfinementPaths,
	type SandboxMountOptions,
} from "../../../src/extensions/workspace/sandbox.js";

const HOME = "/home/op";
const projectRoot = "/home/op/code/proj";
const axiomHome = "/home/op/.axiom";
const primeHome = "/home/op/.prime";
const shadow = ["/home/op/.ssh", "/home/op/.aws"];
const base: SandboxMountOptions = { home: HOME, projectRoot, axiomHome, primeHome, shadowDirs: shadow };

function indexOf(arr: string[], value: string, after = 0): number {
	return arr.indexOf(value, after);
}

describe("buildSandboxMountArgs", () => {
	it("mounts host read-only, writable binds for project+stores, scratch tmpfs, secret shadows", () => {
		const args = buildSandboxMountArgs(base);
		// host read-only
		expect(args[indexOf(args, "--ro-bind") + 1]).toBe("/");
		expect(args[indexOf(args, "--ro-bind") + 2]).toBe("/");
		// scratch tmpfs
		for (const s of ["/tmp", "/run", "/var"]) expect(args).toContain(s);
		// writable binds (project + stores): project appears 3x (bind src/dst + chdir),
		// stores 2x each (bind src+dst)
		expect(args.filter((a) => a === projectRoot).length).toBe(3);
		expect(args.filter((a) => a === axiomHome).length).toBe(2);
		expect(args.filter((a) => a === primeHome).length).toBe(2);
		// secret shadows — each shadowed dir appears once (tmpfs takes one path)
		for (const s of shadow) expect(args.filter((a) => a === s).length).toBe(1);
		// fresh proc/dev + chdir
		expect(args).toContain("/proc");
		expect(args).toContain("/dev");
		expect(indexOf(args, "--chdir")).toBeGreaterThan(indexOf(args, projectRoot));
	});

	it("binds + shadows come after the read-only host so they win (ordering)", () => {
		const args = buildSandboxMountArgs(base);
		const roIdx = indexOf(args, "--ro-bind");
		for (const v of [projectRoot, axiomHome, primeHome, shadow[0], shadow[1], "/proc", "/tmp"]) {
			expect(indexOf(args, v, roIdx)).toBeGreaterThan(roIdx);
		}
	});

	it("emits no shadow tmpfs when none are supplied", () => {
		const args = buildSandboxMountArgs({ home: HOME, projectRoot, axiomHome, primeHome });
		expect(args.filter((a) => a === "--tmpfs").length).toBe(3); // /tmp /run /var only
	});
});

describe("assembleProgramArgv", () => {
	it("places the program and args after the mount args under bwrap", () => {
		const mount = buildSandboxMountArgs(base);
		const argv = assembleProgramArgv("/usr/bin/bwrap", mount, "/usr/bin/node", ["a.js", "-x"]);
		expect(argv[0]).toBe("/usr/bin/bwrap");
		expect(argv.slice(1, 1 + mount.length)).toEqual(mount);
		expect(argv[argv.length - 3]).toBe("/usr/bin/node");
		expect(argv[argv.length - 1]).toBe("-x");
	});
});

describe("resolveConfinementPaths", () => {
	it("defaults to ~/.axiom and ~/.prime under home", () => {
		expect(resolveConfinementPaths(HOME, {})).toEqual({
			axiomHome: "/home/op/.axiom",
			primeHome: "/home/op/.prime",
		});
	});
	it("honors an AXIOM_HOME override", () => {
		expect(resolveConfinementPaths(HOME, { AXIOM_HOME: "/srv/axiom" })).toEqual({
			axiomHome: "/srv/axiom",
			primeHome: "/home/op/.prime",
		});
	});
});

describe("confinementEnv", () => {
	it("adds the AXIOM_CONFINED marker while preserving the base env", () => {
		expect(confinementEnv({ AXIOM_PROJECT_ROOT: "/p", KEEP: "y" })).toEqual({
			AXIOM_PROJECT_ROOT: "/p",
			KEEP: "y",
			AXIOM_CONFINED: "1",
		});
	});
});

describe("resolveBwrap", () => {
	it("finds bubblewrap on PATH when present", () => {
		expect(resolveBwrap({ PATH: process.env.PATH ?? "" })).toBeTruthy();
	});
	it("returns undefined when bwrap is absent", () => {
		expect(resolveBwrap({ PATH: "" })).toBeUndefined();
		expect(resolveBwrap({ PATH: "", AXIOM_BWRAP: "/opt/nope" })).toBeUndefined();
	});
});

describe("defaultShadowDirs", () => {
	it("shadows credential stores but NOT tooling dirs (~/.local ~/.config ~/.cache)", () => {
		// DEFAULT_SHADOW_REL is credential-only: secrets shadowed, tools stay visible.
		expect(DEFAULT_SHADOW_REL).not.toContain(".local");
		expect(DEFAULT_SHADOW_REL).not.toContain(".config");
		expect(DEFAULT_SHADOW_REL).not.toContain(".cache");
		expect(DEFAULT_SHADOW_REL).toContain(".ssh");
		expect(DEFAULT_SHADOW_REL).toContain(".aws");
		// /home/op does not exist on this host -> no dirs qualify (existence gate)
		expect(defaultShadowDirs(HOME)).toEqual([]);
	});
});
