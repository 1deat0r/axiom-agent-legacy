/**
 * Self-update runner for the gateway /update command (hotswap of the WHOLE
 * build, ADR-0034): fetches origin, fast-forwards the configured branch, and
 * rebuilds the axiom bundle, all behind an injected shell so tests script the
 * git/build steps. The running process is untouched until the gateway decides
 * to restart (systemd `Restart=always` brings it back on the new bundle).
 * Strictly erasable TypeScript, top-level imports only.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

/** Where and how to update. */
export interface UpdateConfig {
	/** Absolute path to the git worktree to update. */
	repoDir: string;
	/** Branch the worktree must be on and fast-forward to (default "main"). */
	branch?: string;
	/** cwd for the build step (default <repoDir>/packages/coding-agent). */
	buildCwd?: string;
	/** Build argv (default ["npm","run","build"]). */
	buildCommand?: string[];
}

/** Resolved config with every default applied. */
export interface ResolvedUpdateConfig {
	repoDir: string;
	branch: string;
	buildCwd: string;
	buildCommand: string[];
}

export function resolveUpdateConfig(config: UpdateConfig): ResolvedUpdateConfig {
	const branch = config.branch ?? "main";
	const buildCwd = config.buildCwd ?? join(config.repoDir, "packages", "coding-agent");
	return { repoDir: config.repoDir, branch, buildCwd, buildCommand: config.buildCommand ?? ["npm", "run", "build"] };
}

/** One shelled command's outcome. */
export interface UpdateRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Process boundary for git/build steps (tests inject a scripted fake). */
export interface UpdateShell {
	run(cmd: string[], opts?: { cwd?: string }): Promise<UpdateRunResult>;
}

/** Real shell: spawns the argv, collects stdout/stderr, reports the exit code. */
export class CliUpdateShell implements UpdateShell {
	async run(cmd: string[], opts?: { cwd?: string }): Promise<UpdateRunResult> {
		const child = spawn(cmd[0], cmd.slice(1), { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
		child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (c) => resolve(c));
		});
		return { code, stdout, stderr };
	}
}

export type UpdateCheck =
	| { ok: true; current: string; latest: string; upToDate: boolean }
	| { ok: false; error: string };

export type UpdateApply = { ok: true; from: string; to: string } | { ok: false; error: string };

async function git(shell: UpdateShell, repoDir: string, ...args: string[]): Promise<UpdateRunResult> {
	return shell.run(["git", "-C", repoDir, ...args]);
}

function isClean(result: UpdateRunResult, what: string): { ok: false; error: string } | undefined {
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
		return { ok: false, error: `${what} failed: ${detail}` };
	}
	return undefined;
}

/**
 * Fetch and compare HEAD to origin/<branch>. Refuses unless the worktree is on
 * the configured branch and clean — a live gateway tree must only move by
 * fast-forward (ADR-0034), never over uncommitted work.
 */
export async function checkUpdate(shell: UpdateShell, config: UpdateConfig): Promise<UpdateCheck> {
	const resolved = resolveUpdateConfig(config);
	const branch = await git(shell, resolved.repoDir, "rev-parse", "--abbrev-ref", "HEAD");
	if (branch.code !== 0) return { ok: false, error: `not a git worktree at ${resolved.repoDir}` };
	if (branch.stdout.trim() !== resolved.branch) {
		return { ok: false, error: `worktree is on '${branch.stdout.trim()}', expected '${resolved.branch}'` };
	}
	const status = await git(shell, resolved.repoDir, "status", "--porcelain");
	const statusErr = isClean(status, "worktree check");
	if (statusErr) return statusErr;
	if (status.stdout.trim() !== "") {
		return { ok: false, error: "worktree has uncommitted changes — commit or stash them before updating" };
	}
	const fetch = await git(shell, resolved.repoDir, "fetch", "origin");
	const fetchErr = isClean(fetch, "fetch");
	if (fetchErr) return fetchErr;
	const head = await git(shell, resolved.repoDir, "rev-parse", "HEAD");
	const headErr = isClean(head, "resolving HEAD");
	if (headErr) return headErr;
	const latest = await git(shell, resolved.repoDir, "rev-parse", `origin/${resolved.branch}`);
	const latestErr = isClean(latest, `resolving origin/${resolved.branch}`);
	if (latestErr) return latestErr;
	const current = head.stdout.trim();
	const tip = latest.stdout.trim();
	return { ok: true, current, latest: tip, upToDate: current === tip };
}

/**
 * Fetch, fast-forward origin/<branch>, and rebuild. Any failed step aborts
 * with the error — the gateway keeps serving the old bundle.
 */
export async function applyUpdate(shell: UpdateShell, config: UpdateConfig): Promise<UpdateApply> {
	const resolved = resolveUpdateConfig(config);
	const fetch = await git(shell, resolved.repoDir, "fetch", "origin");
	const fetchErr = isClean(fetch, "fetch");
	if (fetchErr) return fetchErr;
	const head = await git(shell, resolved.repoDir, "rev-parse", "HEAD");
	const headErr = isClean(head, "resolving HEAD");
	if (headErr) return headErr;
	const latest = await git(shell, resolved.repoDir, "rev-parse", `origin/${resolved.branch}`);
	const latestErr = isClean(latest, `resolving origin/${resolved.branch}`);
	if (latestErr) return latestErr;
	const merge = await git(shell, resolved.repoDir, "merge", "--ff-only", `origin/${resolved.branch}`);
	if (merge.code !== 0) {
		const detail = merge.stderr.trim() || `exit ${merge.code}`;
		return { ok: false, error: `merge not fast-forwardable: ${detail}` };
	}
	const build = await shell.run(resolved.buildCommand, { cwd: resolved.buildCwd });
	if (build.code !== 0) {
		const detail = build.stderr.trim() || build.stdout.trim() || `exit ${build.code}`;
		return { ok: false, error: `build failed: ${detail}` };
	}
	return { ok: true, from: head.stdout.trim(), to: latest.stdout.trim() };
}
