/** Type declarations for catalog.mjs (the offline unit tests import it from TypeScript). */

export type CheckEnv = Record<string, string | undefined>;

export interface CheckDeps {
	/** Reports whether the built CLI entry exists (agent-run prerequisite). */
	cliJsExists(path: string): boolean;
	/** Reports whether the built kernel module exists (rlm-kernel prerequisite). */
	kernelModuleExists(path: string): boolean;
	/** Reports whether the built gateway cron module exists (cron-spine prerequisite). */
	gatewayCronModuleExists(path: string): boolean;
	/** Finds a python with ipykernel, or null (rlm-kernel prerequisite). */
	resolveKernelPython(env: CheckEnv): string | null;
}

export interface CheckRunContext {
	env: CheckEnv;
	repoRoot: string;
	log(message: string): void;
	deps: CheckDeps;
}

export interface CheckResult {
	ok: boolean;
	detail: string;
}

export interface Check {
	id: string;
	name: string;
	purpose: string;
	envVars?: string[] | { anyOf: string[] };
	extraRequirements?: Array<{ label: string; satisfied(env: CheckEnv, deps: CheckDeps): boolean }>;
	expectedOutput: string;
	run(ctx: CheckRunContext): Promise<CheckResult>;
}

export interface PlanOutcome {
	runnable: Check[];
	skipped: Array<{ check: Check; reasons: string[] }>;
}

export interface ResultEntry {
	check: Check;
	outcome: "pass" | "fail" | "skip";
	detail: string;
	reasons?: string[];
}

export interface Summary {
	lines: string[];
	ran: number;
	skipped: number;
	passed: number;
	failed: number;
	exitCode: number;
}

export declare const PROVIDER_KEY_ENV_VARS: string[];
export declare const GATEWAY_TOKEN_ENV_VARS: string[];
export declare const SOCKET_MODE_TOKEN_ENV_VARS: string[];
export declare const KERNEL_PYTHON_ENV_VAR: string;
export declare const CHECKS: Check[];

export declare function resolveKernelPython(
	env: CheckEnv,
	spawnImpl?: typeof import("node:child_process").spawnSync,
): string | null;
export declare function resolveGatewayCronModule(env: CheckEnv): string;
export declare function missingRequirements(check: Check, env: CheckEnv, deps: CheckDeps): string[];
export declare function plan(checks: Check[], env: CheckEnv, deps: CheckDeps): PlanOutcome;
export declare function summarize(results: ResultEntry[]): Summary;
export declare function makeDefaultDeps(): CheckDeps;
