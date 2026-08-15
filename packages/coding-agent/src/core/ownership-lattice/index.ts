/**
 * Ownership lattice (ADR-0081, issue #55) — the code-enforced map over what
 * the learning loop may write.
 *
 * RED-FIRST STUB: this module pins the type contract the fence
 * (test/ownership-lattice.test.ts) drives. Every function throws until the
 * implementation lands; the test suite is red against this stub by design
 * (execution rules: WIP branches may carry red tests).
 */
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

/** The learning actor's sanctioned operations (ADR-0081). */
export const LEARNING_ACTOR_TOOLSET: readonly string[] = [];

function notImplemented(): never {
	throw new Error("ownership lattice: not implemented (red-first stub)");
}

export function defaultLatticeConfig(options: DefaultLatticeConfigOptions): LatticeConfig {
	void options;
	notImplemented();
}

export function classifyPath(target: string, config: LatticeConfig): Classification {
	void target;
	void config;
	notImplemented();
}

export function admitWrite(
	target: string,
	options: { actor: Actor; operation: string },
	config: LatticeConfig,
): AdmissionVerdict {
	void target;
	void options;
	void config;
	notImplemented();
}

export function installCapturedSkill(request: SkillInstallRequest, config: LatticeConfig): SkillInstallResult {
	void request;
	void config;
	notImplemented();
}
