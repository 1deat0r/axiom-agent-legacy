/**
 * OS-tier confinement for anchored project runs (ADR-0018 strict tier).
 *
 * Pure, dependency-free building blocks for a bubblewrap sandbox. The gateway
 * wraps the WHOLE completion child (and with it the freeform bash tool and the
 * persistent ipython kernel, which inherit the mount namespace) in one
 * kernel-enforced boundary — there is no string-level guard on shell commands,
 * because freeform commands cannot be confined reliably (that is the ADR-0018
 * gap this closes).
 *
 * Mount model (order matters — a later bind overrides both the read-only host
 * and the tmpfs home):
 *   --ro-bind / /            : host visible but READ-ONLY
 *   --tmpfs /tmp /run /var   : writable scratch that is NOT the host's dirs
 *   --tmpfs <home>           : operator home blanked (no host reads/writes)
 *   --bind <project|stores>  : the only writable host surfaces (re-exposed)
 *   --proc /proc --dev /dev  : fresh namespace proc + minimal dev
 *   --chdir <projectRoot>    : the anchored work area
 *
 * Honest, deliberate scope (recorded in ADR-0019): `--ro-bind / /` keeps the
 * host READABLE (though home/tmp/var are shadowed) and network is inherited —
 * read-minimal allowlisting and network isolation are documented follow-ups.
 * If bubblewrap is absent the caller FAILS CLOSED; this module never falls
 * back to an unconfined run.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The writable surfaces a sandboxed completion child needs. */
export interface SandboxMountOptions {
	/** HOME to blank out (shadowed as tmpfs, then stores re-exposed). */
	home: string;
	/** Anchored project root — the writable work area + chdir target. */
	projectRoot: string;
	/** AXIOM_HOME (default ~/.axiom): profiles, ledger, session state. */
	axiomHome: string;
	/** Prime agent dir (default ~/.prime): kernel venv, skills, agent state. */
	primeHome: string;
}

/**
 * Build the bubblewrap mount-args (the options BEFORE the program). Returns a
 * fresh array each call so callers can mutate safely.
 */
export function buildSandboxMountArgs(o: SandboxMountOptions): string[] {
	return [
		"--ro-bind",
		"/",
		"/",
		"--tmpfs",
		"/tmp",
		"--tmpfs",
		"/run",
		"--tmpfs",
		"/var",
		"--tmpfs",
		o.home,
		"--bind",
		o.projectRoot,
		o.projectRoot,
		"--bind",
		o.axiomHome,
		o.axiomHome,
		"--bind",
		o.primeHome,
		o.primeHome,
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--chdir",
		o.projectRoot,
	];
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

/**
 * Resolve where the child's persistent stores live, defaulting under home.
 * AXIOM_HOME overrides the axiom store; the prime agent dir is always
 * `~/.prime` (kernel-venv etc.).
 */
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
 * Locate the bubblewrap binary. Honors an AXIOM_BWRAP override, else scans
 * PATH. Returns undefined when absent — callers MUST fail closed.
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
