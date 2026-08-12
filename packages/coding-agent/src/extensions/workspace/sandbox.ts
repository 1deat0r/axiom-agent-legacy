/**
 * OS-tier confinement for anchored project runs (ADR-0018 strict tier).
 *
 * Pure, dependency-free building blocks for a bubblewrap sandbox. The gateway
 * wraps the WHOLE completion child (and with it the freeform bash tool and the
 * persistent ipython kernel, which inherit the mount namespace) in one
 * kernel-enforced boundary — there is no string-level guard on shell commands,
 * because freeform commands cannot be confined reliably (the ADR-0018 gap this
 * closes).
 *
 * Mount model (order matters — a later bind overrides an earlier one):
 *   --ro-bind / /            : host visible but READ-ONLY
 *   --tmpfs /tmp /run /var   : writable scratch that is NOT the host's dirs
 *   --bind <project|stores>  : the only writable host surfaces, re-exposed
 *   --tmpfs <secret dirs>    : shadow ~/.ssh, ~/.aws, ... so they are unreadable
 *   --proc /proc --dev /dev  : fresh namespace proc + minimal dev
 *   --chdir <projectRoot>    : the anchored work area
 *
 * The host home stays READABLE (so axiom's own CLI / node_modules under $HOME
 * still execute) but every host path except the writable binds/tmpfs is
 * read-only: complete WRITE confinement. Read hardening is shadowing the
 * explicit secret dirs; a read-minimal allowlist and network isolation are
 * documented follow-ups. If bubblewrap is absent the caller FAILS CLOSED; this
 * module never falls back to an unconfined run.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Sensitive dirs under HOME shadowed as empty tmpfs (unreadable + writable-apart). */
export const DEFAULT_SHADOW_REL: readonly string[] = [
	".ssh",
	".aws",
	".gnupg",
	".config",
	".local",
	".cache",
	".netrc",
];

/** The writable surfaces + read-shadows a sandboxed completion child needs. */
export interface SandboxMountOptions {
	/** HOME used to derive default read-shadows. */
	home: string;
	/** Anchored project root — the writable work area + chdir target. */
	projectRoot: string;
	/** AXIOM_HOME (default ~/.axiom): profiles, ledger, session state. */
	axiomHome: string;
	/** Prime agent dir (default ~/.prime): kernel venv, skills, agent state. */
	primeHome: string;
	/** Extra absolute dirs to shadow (in addition to built-in secrets). */
	shadowDirs?: readonly string[];
}

/** Resolve the built-in secret dirs for a home, keeping only those that exist. */
export function defaultShadowDirs(home: string): string[] {
	return DEFAULT_SHADOW_REL.map((rel) => join(home, rel)).filter((p) => existsSync(p));
}

/**
 * Build the bubblewrap mount-args (options BEFORE the program). Fresh array per
 * call. The caller supplies shadowDirs (normally defaultShadowDirs(home)) that
 * already exist, so bwrap never mounts on a missing destination.
 */
export function buildSandboxMountArgs(o: SandboxMountOptions): string[] {
	const args = [
		"--ro-bind",
		"/",
		"/",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--tmpfs",
		"/var",
		"--bind",
		o.projectRoot,
		o.projectRoot,
		"--bind",
		o.axiomHome,
		o.axiomHome,
		"--bind",
		o.primeHome,
		o.primeHome,
	];
	for (const d of o.shadowDirs ?? []) {
		args.push("--tmpfs", d);
	}
	args.push("--proc", "/proc", "--dev", "/dev", "--chdir", o.projectRoot);
	return args;
}

/** Full argv for spawning the confined program: [bwrap, ...mount, program, ...args]. */
export function assembleProgramArgv(
	bwrapPath: string,
	mountArgs: string[],
	program: string,
	programArgs: readonly string[],
): string[] {
	return [bwrapPath, ...mountArgs, program, ...programArgs];
}

/** Resolve the child's persistent stores, defaulting under home. */
export function resolveConfinementPaths(
	home: string,
	env: NodeJS.ProcessEnv = process.env,
): { axiomHome: string; primeHome: string } {
	return {
		axiomHome: env.AXIOM_HOME ?? join(home, ".axiom"),
		primeHome: join(home, ".prime"),
	};
}

/** Inject the confinement marker into the child env (base env preserved). */
export function confinementEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return { ...base, AXIOM_CONFINED: "1" };
}

/**
 * Locate the bubblewrap binary. Honors AXIOM_BWRAP, else scans PATH. Returns
 * undefined when absent — callers MUST fail closed.
 */
export function resolveBwrap(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const candidates: string[] = [];
	const override = env.AXIOM_BWRAP;
	if (override) candidates.push(override);
	for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
		candidates.push(join(dir, "bwrap"));
	}
	for (const c of candidates) {
		if (existsSync(c) && c.length > 0) return c;
	}
	return undefined;
}
