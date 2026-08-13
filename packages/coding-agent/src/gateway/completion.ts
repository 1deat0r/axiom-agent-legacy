/**
 * Completion adapter: runs one agent completion per channel via the existing
 * headless-completion seam (`axiom <print-mode> -p "..."`), under the chosen
 * profile. The CLI already loads the axiom built-in extensions and, through
 * --profile, sets AXIOM_HOME + the agent dir, so axiom-profile's
 * before_agent_start appends the profile's SOUL.md to the prompt (ADR-0014/15).
 *
 * Behind a `CompletionRunner` interface so the router and end-to-end tests
 * inject a fake runner; the shipped `CliCompletionRunner` shells the real CLI.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assembleProgramArgv,
	buildSandboxMountArgs,
	confinementEnv,
	defaultShadowDirs,
	resolveBwrap,
	resolveConfinementPaths,
} from "../extensions/workspace/sandbox.js";
import type { CompletionRunner, GatewayProfile } from "./types.js";

/** Deterministic, channel-stable session id so resume just re-passes it. */
export function sessionIdForChannel(channelId: string): string {
	// Finite + filesystem-safe, no external crypto dependency.
	let h = 2166136261;
	for (let i = 0; i < channelId.length; i++) {
		h ^= channelId.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return `gw-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * The child process spec for one completion: the executable and any loader
 * prefix args. Resolved so the runner ALWAYS invokes axiom-agent's own CLI —
 * never the ambiguous global `axiom` on PATH (a stale/different install would
 * silently produce no reply, which is exactly the bug this fixes).
 */
export interface CompletionChild {
	bin: string;
	prefix: string[];
}

/**
 * Resolve the axiom CLI child to spawn. Priority: an explicit bin (tests),
 * AXIOM_BIN (operator override), then axiom-agent's own entrypoint — the built
 * `dist/bundle/cli.js` of this package, else the source `src/cli.ts` via
 * `node --import tsx`. There is deliberately NO bare-`"axiom"` fallback.
 */
export function resolveCompletionChild(userBin?: string): CompletionChild {
	if (userBin) return { bin: userBin, prefix: [] };
	if (process.env.AXIOM_BIN) return { bin: process.env.AXIOM_BIN, prefix: [] };
	const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const distCli = join(pkgRoot, "dist", "bundle", "cli.js");
	if (existsSync(distCli)) return { bin: distCli, prefix: [] };
	const srcCli = join(pkgRoot, "src", "cli.ts");
	return { bin: process.execPath, prefix: ["--import", "tsx", srcCli] };
}

export interface CliCompletionOptions {
	/** The axiom CLI binary to spawn. If omitted, resolves to axiom-agent's own CLI. */
	bin?: string;
	/** Print-mode the CLI exposes (`-p`/`--print`). */
	printFlag?: string;
	/**
	 * Anchor this completion to a project workspace: spawn the child with cwd =
	 * the project root and AXIOM_PROJECT_ROOT set, so relative work starts
	 * inside the project and the workspace root guard (ADR-0014 rung 3) enforces
	 * the edit boundary. Omit for unanchored runs.
	 */
	projectRoot?: string;
	/**
	 * Confinement overrides for tests: force a bwrap binary path (or a
	 * nonexistent one to exercise the fail-closed path) and the store homes.
	 * Omit in production — defaults resolve from the environment.
	 */
	confinement?: {
		bwrap?: string;
		axiomHome?: string;
		agentHome?: string;
		/** Extra host dirs to shadow, merged over the credential-only default. */
		shadowDirs?: string[];
	};
	/**
	 * Bounded wait for one completion before giving up. Completions are
	 * serialized per channel, so a single hang must not wedge the channel
	 * forever: if the child neither exits nor finishes within this window we
	 * kill it and surface an error reply instead of blocking all later
	 * messages on that channel.
	 */
	timeoutMs?: number;
}

/** Real completion runner: shells the axiom CLI in print mode under --profile. */
export class CliCompletionRunner implements CompletionRunner {
	private readonly bin: string;
	private readonly prefix: string[];
	private readonly printFlag: string;
	private readonly timeoutMs: number;
	private readonly projectRoot?: string;
	private readonly confinement?: { bwrap?: string; axiomHome?: string; agentHome?: string; shadowDirs?: string[] };
	constructor(options: CliCompletionOptions = {}) {
		const child = resolveCompletionChild(options.bin);
		this.bin = child.bin;
		this.prefix = child.prefix;
		this.printFlag = options.printFlag ?? "-p";
		this.timeoutMs = options.timeoutMs ?? 300_000;
		this.projectRoot = options.projectRoot;
		this.confinement = options.confinement;
	}
	/**
	 * Resolve the spawn argv + env for a completion child, confining anchored
	 * runs inside bubblewrap (ADR-0018 strict tier). Unanchored runs spawn
	 * directly. Throws when an anchored run has no bwrap (fail closed).
	 */
	private buildSpawn(
		args: string[],
		root: string | undefined,
	): { spawnargv: string[]; childEnv: NodeJS.ProcessEnv | undefined; confined: boolean } {
		if (!root) return { spawnargv: [this.bin, ...args], childEnv: undefined, confined: false };
		const bwrap = this.confinement?.bwrap ?? resolveBwrap(process.env);
		if (!bwrap) {
			throw new Error(
				"Anchored run requires bubblewrap (bwrap) for OS-tier confinement, but it was not found. " +
					"Install bubblewrap (or set AXIOM_BWRAP to its path), or run this gateway without " +
					"--project. Refusing to spawn the completion unconfined.",
			);
		}
		const home = homedir();
		const stores = resolveConfinementPaths(home, process.env);
		const axiomHome = this.confinement?.axiomHome ?? stores.axiomHome;
		const agentHome = this.confinement?.agentHome ?? stores.agentHome;
		try {
			mkdirSync(axiomHome, { recursive: true });
			mkdirSync(agentHome, { recursive: true });
		} catch {
			/* a missing store still fails closed at spawn (bind error) */
		}
		const mount = buildSandboxMountArgs({
			home,
			projectRoot: root,
			axiomHome,
			agentHome,
			shadowDirs: this.confinement?.shadowDirs ?? defaultShadowDirs(home),
		});
		return {
			spawnargv: assembleProgramArgv(bwrap, mount, this.bin, args),
			childEnv: confinementEnv({ ...process.env, AXIOM_PROJECT_ROOT: root }),
			confined: true,
		};
	}

	async runCompletion(input: {
		sessionId: string;
		prompt: string;
		profile: GatewayProfile;
		model?: { provider: string; model: string };
		projectRoot?: string;
	}): Promise<{ reply: string; sessionId: string; error?: string }> {
		// Per-call override wins over the boot-time anchor; BOTH thread through
		// every anchoring point below (bwrap mount, cwd, AXIOM_PROJECT_ROOT,
		// [sandbox-confined] prefix) so an override can never silently run
		// unconfined.
		const root = input.projectRoot ?? this.projectRoot;
		// Always pass --profile so the spawned agent resolves the profile home
		// (~/.axiom/profiles/<name>, incl. 'default') and reads that profile's
		// provider settings (e.g. ~/.axiom/profiles/default/settings.json).
		const args = [
			...this.prefix,
			this.printFlag,
			input.prompt,
			"--profile",
			input.profile.name,
			"--session-id",
			input.sessionId,
		];
		// Active-model hotswap (/model): force the operator's chosen provider+model
		// on this completion. Provider is optional (empty keeps the profile's).
		if (input.model) {
			if (input.model.provider) args.push("--provider", input.model.provider);
			args.push("--model", input.model.model);
		}
		try {
			const { spawnargv, childEnv, confined } = this.buildSpawn(args, root);
			const stdout = await new Promise<string>((resolve, reject) => {
				// Spawn and collect stdout ourselves rather than execFile: the
				// completion CLI writes its final answer to stdio, and execFile's
				// internal pipe collection can deadlock in some hosts. Stdio here
				// is stdin ignored, stdout+stderr piped so we can collect the reply.
				const child = spawn(spawnargv[0], spawnargv.slice(1), {
					stdio: ["ignore", "pipe", "pipe"],
					cwd: root,
					env: childEnv,
				});
				let collected = "";
				let settled = false;
				child.stdout?.on("data", (d) => (collected += d.toString("utf8")));
				child.stderr?.on("data", () => {
					/* drain stderr; the reply / errors stream on stdout */
				});
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGKILL");
					reject(new Error(`completion timed out after ${this.timeoutMs}ms: ${[this.bin, ...args].join(" ")}`));
				}, this.timeoutMs);
				timer.unref?.();
				child.on("error", (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(error);
				});
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (code === 0) {
						resolve(collected);
					} else {
						reject(
							new Error(
								`completion exited with code ${String(code ?? "unknown")}: ${[this.bin, ...args].join(" ")}`,
							),
						);
					}
				});
			});
			const reply = confined ? `[sandbox-confined] ${stdout.trimEnd()}` : stdout.trimEnd();
			return { reply, sessionId: input.sessionId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { reply: "", sessionId: input.sessionId, error: message };
		}
	}

	/**
	 * Streaming completion (ADR-0004/#6): run the child with `--mode json`,
	 * parse the JSON event lines, forward `text_delta` chunks to `onDelta`, and
	 * return the accumulated reply. The CLI streams the provider's text deltas
	 * as JSON events, so the gateway can edit a Telegram message in place.
	 */
	async streamCompletion(
		input: {
			sessionId: string;
			prompt: string;
			profile: GatewayProfile;
			model?: { provider: string; model: string };
			projectRoot?: string;
		},
		onDelta: (delta: string) => void,
	): Promise<{ reply: string; sessionId: string; error?: string }> {
		const root = input.projectRoot ?? this.projectRoot;
		const args = [
			...this.prefix,
			"--mode",
			"json",
			input.prompt,
			"--profile",
			input.profile.name,
			"--session-id",
			input.sessionId,
		];
		if (input.model) {
			if (input.model.provider) args.push("--provider", input.model.provider);
			args.push("--model", input.model.model);
		}
		try {
			const { spawnargv, childEnv, confined } = this.buildSpawn(args, root);
			let full = "";
			const collected = await new Promise<string>((resolve, reject) => {
				const child = spawn(spawnargv[0], spawnargv.slice(1), {
					stdio: ["ignore", "pipe", "pipe"],
					cwd: root,
					env: childEnv,
				});
				let buffer = "";
				let settled = false;
				child.stdout?.on("data", (d) => {
					buffer += d.toString("utf8");
					for (;;) {
						const nl = buffer.indexOf("\n");
						if (nl < 0) break;
						const line = buffer.slice(0, nl).trim();
						buffer = buffer.slice(nl + 1);
						if (!line) continue;
						let obj: unknown;
						try {
							obj = JSON.parse(line);
						} catch {
							continue;
						}
						if (
							typeof obj === "object" &&
							obj !== null &&
							((obj as { type?: unknown }).type === "text_delta" ||
								(typeof (obj as { assistantMessageEvent?: unknown }).assistantMessageEvent === "object" &&
									(obj as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent !== null &&
									(obj as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent?.type ===
										"text_delta"))
						) {
							// v2 format: top-level {type:"text_delta", delta}; v3 format:
							// {type:"message_update", assistantMessageEvent:{type:"text_delta", delta}}.
							const delta =
								(obj as { delta?: unknown }).delta ??
								(
									obj as {
										assistantMessageEvent?: { delta?: unknown };
									}
								).assistantMessageEvent?.delta;
							if (typeof delta === "string") {
								full += delta;
								onDelta(delta);
							}
						}
					}
				});
				child.stderr?.on("data", () => {
					/* drain stderr; deltas stream on stdout */
				});
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill("SIGKILL");
					reject(new Error(`completion timed out after ${this.timeoutMs}ms: ${[this.bin, ...args].join(" ")}`));
				}, this.timeoutMs);
				timer.unref?.();
				child.on("error", (error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(error);
				});
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (code === 0) {
						resolve(full);
					} else {
						reject(
							new Error(
								`completion exited with code ${String(code ?? "unknown")}: ${[this.bin, ...args].join(" ")}`,
							),
						);
					}
				});
			});
			const reply = confined ? `[sandbox-confined] ${collected.trimEnd()}` : collected.trimEnd();
			return { reply, sessionId: input.sessionId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { reply: "", sessionId: input.sessionId, error: message };
		}
	}
}

/** A canned, injectable completion runner for router/e2e tests. */
export function fakeCompletionRunner(): CompletionRunner & {
	calls: Array<{
		sessionId: string;
		prompt: string;
		model: { provider: string; model: string } | undefined;
		projectRoot?: string;
	}>;
} {
	const runner: CompletionRunner & {
		calls: Array<{
			sessionId: string;
			prompt: string;
			model: { provider: string; model: string } | undefined;
			projectRoot?: string;
		}>;
	} = {
		calls: [],
		async runCompletion(input) {
			this.calls.push({
				sessionId: input.sessionId,
				prompt: input.prompt,
				model: input.model,
				projectRoot: input.projectRoot,
			});

			return { reply: `axiom reply to: ${input.prompt}`, sessionId: input.sessionId };
		},
		async streamCompletion(input, onDelta) {
			this.calls.push({
				sessionId: input.sessionId,
				prompt: input.prompt,
				model: input.model,
				projectRoot: input.projectRoot,
			});
			const reply = `axiom reply to: ${input.prompt}`;
			// Emit the whole reply as two deltas so the streamed bubble ends on the
			// final text (exercises the no-duplicate path).
			onDelta(reply.slice(0, Math.floor(reply.length / 2)));
			onDelta(reply.slice(Math.floor(reply.length / 2)));
			return { reply, sessionId: input.sessionId };
		},
	};
	return runner;
}
