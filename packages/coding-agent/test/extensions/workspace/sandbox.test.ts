import { describe, expect, it } from "vitest";
import {
	assembleProgramArgv,
	buildSandboxMountArgs,
	confinementEnv,
	resolveBwrap,
	resolveConfinementPaths,
	type SandboxMountOptions,
} from "../../../src/extensions/workspace/sandbox.js";

const HOME = "/home/op";
const projectRoot = "/home/op/code/proj";
const axiomHome = "/home/op/.axiom";
const primeHome = "/home/op/.prime";
const base: SandboxMountOptions = { home: HOME, projectRoot, axiomHome, primeHome };

function indexOf(arr: string[], value: string, after = 0): number {
	return arr.indexOf(value, after);
}

describe("buildSandboxMountArgs", () => {
	it("mounts the host read-only, shadows sensitive dirs, and re-exposes writable stores", () => {
		const args = buildSandboxMountArgs(base);
		expect(indexOf(args, "--ro-bind")).toBeGreaterThanOrEqual(0);
		expect(args[indexOf(args, "--ro-bind") + 1]).toBe("/");
		expect(args[indexOf(args, "--ro-bind") + 2]).toBe("/");
		for (const shadowed of ["/tmp", "/run", "/var", HOME]) {
			expect(args).toContain(shadowed);
		}
		for (const bound of [projectRoot, axiomHome, primeHome]) {
			expect(args.filter((a) => a === bound).length).toBeGreaterThanOrEqual(2);
		}
		expect(args).toContain("/proc");
		expect(args).toContain("/dev");
		expect(indexOf(args, "--chdir")).toBeGreaterThan(indexOf(args, projectRoot));
	});

	it("writable binds override both the tmpfs home and the read-only host (ordering)", () => {
		const args = buildSandboxMountArgs(base);
		const roIdx = indexOf(args, "--ro-bind");
		const tmpIdx = indexOf(args, "--tmpfs", roIdx);
		expect(tmpIdx).toBeGreaterThan(roIdx);
		for (const bound of [projectRoot, axiomHome, primeHome]) {
			expect(indexOf(args, bound, roIdx)).toBeGreaterThan(indexOf(args, "--bind", roIdx));
		}
	});
});

describe("assembleProgramArgv", () => {
	it("places the program and its args after the mount args under bwrap", () => {
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
		const p = resolveConfinementPaths(HOME, {});
		expect(p).toEqual({ axiomHome: "/home/op/.axiom", primeHome: "/home/op/.prime" });
	});
	it("honors an AXIOM_HOME override", () => {
		const p = resolveConfinementPaths(HOME, { AXIOM_HOME: "/srv/axiom" });
		expect(p.axiomHome).toBe("/srv/axiom");
		expect(p.primeHome).toBe("/home/op/.prime");
	});
});

describe("confinementEnv", () => {
	it("adds the AXIOM_CONFINED marker while preserving the base env", () => {
		const env = confinementEnv({ AXIOM_PROJECT_ROOT: "/p", IMPORTANT: "keep" });
		expect(env.AXIOM_CONFINED).toBe("1");
		expect(env.AXIOM_PROJECT_ROOT).toBe("/p");
		expect(env.IMPORTANT).toBe("keep");
	});
});

describe("resolveBwrap", () => {
	it("finds bubblewrap on PATH when present", () => {
		const found = resolveBwrap({ PATH: process.env.PATH ?? "" });
		expect(found).toBeTruthy();
	});
	it("returns undefined when bwrap is absent", () => {
		expect(resolveBwrap({ PATH: "" })).toBeUndefined();
		expect(resolveBwrap({ PATH: "", AXIOM_BWRAP: "/opt/nope" })).toBeUndefined();
	});
});
