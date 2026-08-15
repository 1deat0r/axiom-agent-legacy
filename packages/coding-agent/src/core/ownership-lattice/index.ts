/**
 * Ownership lattice (ADR-0081, issue #55) — the code-enforced map over what
 * the learning loop may write.
 *
 * Three layers over the paths axiom owns: pin (the floor — never admitted for
 * any lattice-routed write), protected (user-owned work — refused for the
 * learning actor, admitted for operator-routed writes), and curator (the
 * loop's own territory — admitted for both actors; the learning actor only
 * through its whitelisted toolset). Classification is lexical path policy,
 * not confinement: the most specific boundary-safe root wins, a layer tie
 * resolves toward the stricter layer, and unmapped paths are `outside` —
 * denied for every actor. Symlink tricks and races stay with the ADR-0019 OS
 * sandbox; this module records the boundary honestly, it does not fake one.
 *
 * `installCapturedSkill` is the first consumer: a staged capture installs
 * only into a curator-managed live skills directory, verified through the
 * real skill loader (the ADR-0024 proof); protected targets get the manual
 * command printed, never run.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.js";
import { consolidationAuditPath } from "../memory-consolidation/store.js";
import { loadSkillsFromDir } from "../skills.js";

export type LatticeLayer = "pin" | "protected" | "curator";
export type Actor = "learning" | "operator";

export interface LatticeRoot {
	path: string;
	layer: LatticeLayer;
}

export interface LatticeConfig {
	roots: LatticeRoot[];
}

export interface DefaultLatticeConfigOptions {
	axiomHome: string;
	agentDir: string;
	cwd: string;
	bundledSkillsDir: string;
	harnessStateDir: string;
}

export type Classification = { layer: LatticeLayer | "outside"; root?: LatticeRoot };

export type AdmissionVerdict =
	| { admitted: true; layer: "curator" | "protected" }
	| { admitted: false; layer: LatticeLayer | "outside"; reason: string };

export interface SkillInstallRequest {
	fromDir: string;
	name: string;
	toDir: string;
}

export type SkillInstallResult =
	| { ok: true; kind: "installed"; name: string; from: string; to: string; diagnostics: string[] }
	| { ok: false; kind: "refused"; reason: string; layer: LatticeLayer | "outside"; manual?: string }
	| { ok: false; kind: "missing"; errors: string[] }
	| { ok: false; kind: "exists"; path: string; errors: string[] }
	| { ok: false; kind: "error"; errors: string[] };

/**
 * The learning actor's sanctioned operations (ADR-0081): the loop writes
 * silently only its own memories and captured skills — nothing broader.
 */
export const LEARNING_ACTOR_TOOLSET: readonly string[] = [
	"memory.apply",
	"memory.stage",
	"skill.capture",
	"skill.install",
];

/** Curator territory names the lattice owns (ADR-0081) — single house for the
 *  dirs the capture surfaces and the config builder both use. */
export const CAPTURED_SKILLS_DIR_NAME = "captured-skills";
export const CURATOR_SKILLS_DIR_NAME = "curator-skills";
export const CONSOLIDATION_DIR_NAME = "consolidation";

/** Most-specific-root severity: a tie between layers resolves stricter. */
const LAYER_SEVERITY: Record<LatticeLayer, number> = { pin: 3, protected: 2, curator: 1 };

/** The repo-floor signature: the creed at the root with the test suite and
 *  the packages tree beside it. When cwd carries all three, the floor is
 *  pinned; anything else is covered by deny-by-default. */
function isRepoFloor(cwd: string): boolean {
	return existsSync(join(cwd, "SOUL.md")) && existsSync(join(cwd, "packages")) && existsSync(join(cwd, "test"));
}

/** The map ADR-0081 decides, built from the same constants the loaders use so
 *  the lattice cannot drift from where sessions actually read. */
export function defaultLatticeConfig(options: DefaultLatticeConfigOptions): LatticeConfig {
	const roots: LatticeRoot[] = [
		// curator — the loop's own territory: staging, the live skills dir,
		// consolidation staging, and the harness memory store.
		{ path: join(options.axiomHome, CAPTURED_SKILLS_DIR_NAME), layer: "curator" },
		{ path: join(options.axiomHome, CURATOR_SKILLS_DIR_NAME), layer: "curator" },
		{ path: join(options.axiomHome, CONSOLIDATION_DIR_NAME), layer: "curator" },
		{ path: options.harnessStateDir, layer: "curator" },
		// protected — user-owned work: the operator's skills, global and per project.
		{ path: join(options.agentDir, "skills"), layer: "protected" },
		{ path: join(options.cwd, CONFIG_DIR_NAME, "skills"), layer: "protected" },
		// pin — the floor: the bundled skills, the witness audit log, and the
		// profile soul. The witness append is the sanctioned primitive, not a
		// lattice-routed write, so pin stays absolute here.
		{ path: options.bundledSkillsDir, layer: "pin" },
		{ path: consolidationAuditPath(join(options.axiomHome, CONSOLIDATION_DIR_NAME)), layer: "pin" },
		{ path: join(options.agentDir, "SOUL.md"), layer: "pin" },
	];
	if (isRepoFloor(options.cwd)) {
		roots.push({ path: join(options.cwd, "SOUL.md"), layer: "pin" });
		roots.push({ path: join(options.cwd, "test"), layer: "pin" });
		roots.push({ path: join(options.cwd, "packages"), layer: "pin" });
	}
	return { roots };
}

/** Boundary-safe lexical segments: a root matches only when every segment
 *  equals the target's prefix, so a file root never bleeds into `SOUL.md.bak`
 *  and a directory root never bleeds into `curator-skills-evil`. */
function toSegments(path: string): string[] {
	return resolve(path)
		.split(sep)
		.filter((segment) => segment !== "");
}

/** Longest-prefix match over the lexical segments; specificity is the root's
 *  segment count, so the most specific root always wins a nesting. */
function matchRoot(targetSegments: string[], rootPath: string): number | undefined {
	const rootSegments = toSegments(rootPath);
	if (rootSegments.length === 0 || rootSegments.length > targetSegments.length) {
		return undefined;
	}
	for (let index = 0; index < rootSegments.length; index += 1) {
		if (rootSegments[index] !== targetSegments[index]) {
			return undefined;
		}
	}
	return rootSegments.length;
}

export function classifyPath(target: string, config: LatticeConfig): Classification {
	const targetSegments = toSegments(target);
	let best: { root: LatticeRoot; specificity: number } | undefined;
	for (const root of config.roots) {
		const specificity = matchRoot(targetSegments, root.path);
		if (specificity === undefined) {
			continue;
		}
		if (
			!best ||
			specificity > best.specificity ||
			(specificity === best.specificity && LAYER_SEVERITY[root.layer] > LAYER_SEVERITY[best.root.layer])
		) {
			best = { root, specificity };
		}
	}
	if (!best) {
		return { layer: "outside" };
	}
	return { layer: best.root.layer, root: best.root };
}

export function admitWrite(
	target: string,
	options: { actor: Actor; operation: string },
	config: LatticeConfig,
): AdmissionVerdict {
	const classification = classifyPath(target, config);
	if (classification.layer === "pin") {
		return {
			admitted: false,
			layer: "pin",
			reason: "pinned territory: no lattice-routed write is admitted on the floor",
		};
	}
	if (classification.layer === "outside") {
		return {
			admitted: false,
			layer: "outside",
			reason: "unmapped territory: the lattice fails closed outside mapped paths",
		};
	}
	if (options.actor === "learning") {
		if (classification.layer !== "curator") {
			return {
				admitted: false,
				layer: classification.layer,
				reason: "user-owned (protected) territory is refused for the learning actor; operator-routed writes only",
			};
		}
		if (!LEARNING_ACTOR_TOOLSET.includes(options.operation)) {
			return {
				admitted: false,
				layer: classification.layer,
				reason: `operation "${options.operation}" is not in the learning actor's whitelisted toolset`,
			};
		}
		return { admitted: true, layer: "curator" };
	}
	// Operator-routed writes: the pinned floor and unmapped territory are
	// already refused above; curator and protected are admitted.
	return { admitted: true, layer: classification.layer };
}

/** A shell-safe single-quoted form so the manual command is exact. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The exact cp -r an operator would run to move a capture into protected
 *  territory — printed, never executed by the loop. */
function manualInstallCommand(from: string, toDir: string): string {
	return `cp -r ${shellQuote(from)} ${shellQuote(toDir)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function installCapturedSkill(request: SkillInstallRequest, config: LatticeConfig): SkillInstallResult {
	const from = join(request.fromDir, request.name);
	const to = join(request.toDir, request.name);

	const sourceClassification = classifyPath(request.fromDir, config);
	if (sourceClassification.layer !== "curator") {
		return {
			ok: false,
			kind: "refused",
			reason: `capture source is ${sourceClassification.layer}, not curator staging`,
			layer: sourceClassification.layer,
		};
	}

	const targetClassification = classifyPath(request.toDir, config);
	switch (targetClassification.layer) {
		case "pin":
			return {
				ok: false,
				kind: "refused",
				reason: "pinned target: no install is admitted on the floor",
				layer: "pin",
			};
		case "outside":
			return {
				ok: false,
				kind: "refused",
				reason: "unmapped target: installs fail closed outside mapped territory",
				layer: "outside",
			};
		case "protected":
			return {
				ok: false,
				kind: "refused",
				reason: "protected target: the loop never writes user-owned skills",
				layer: "protected",
				manual: manualInstallCommand(from, request.toDir),
			};
		case "curator":
			break;
	}

	if (!existsSync(from)) {
		return { ok: false, kind: "missing", errors: [`capture not found at ${from}`] };
	}
	// The admitted curator target may not exist yet (a first install): the
	// primitive creates it, exactly like capture staging creates its dir.
	// This only runs after the target classified curator — protected, pinned,
	// and unmapped targets are refused above with nothing created.
	try {
		mkdirSync(request.toDir, { recursive: true });
	} catch (error) {
		return { ok: false, kind: "error", errors: [`failed to create install directory: ${errorMessage(error)}`] };
	}
	if (existsSync(to)) {
		return {
			ok: false,
			kind: "exists",
			path: to,
			errors: ["a skill with this name is already installed"],
		};
	}

	try {
		cpSync(from, to, { recursive: true, errorOnExist: true });
	} catch (error) {
		return { ok: false, kind: "error", errors: [`failed to copy skill: ${errorMessage(error)}`] };
	}

	// The ADR-0024 proof, applied to the copy: the installed skill must load
	// through the real loader with zero diagnostics, or the install is rolled
	// back — a capture that verifies in staging must verify where it lands.
	const { skills, diagnostics } = loadSkillsFromDir({ dir: request.toDir, source: "local" });
	const found = skills.find((skill) => skill.name === request.name);
	const diagnosticMessages = diagnostics.map((diagnostic) => diagnostic.message);
	if (!found || diagnosticMessages.length > 0) {
		rmSync(to, { recursive: true, force: true });
		return {
			ok: false,
			kind: "error",
			errors: [...(found ? [] : ["installed skill not found after copy"]), ...diagnosticMessages],
		};
	}
	return {
		ok: true,
		kind: "installed",
		name: request.name,
		from,
		to: request.toDir,
		diagnostics: diagnosticMessages,
	};
}
