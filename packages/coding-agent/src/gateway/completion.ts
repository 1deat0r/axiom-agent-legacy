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
import { execFile } from "node:child_process";
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

export interface CliCompletionOptions {
	/** The axiom CLI binary to spawn. */
	bin?: string;
	/** Print-mode the CLI exposes (`-p`/`--print`). */
	printFlag?: string;
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
	private readonly printFlag: string;
	private readonly timeoutMs: number;
	constructor(options: CliCompletionOptions = {}) {
		this.bin = options.bin ?? process.env.AXIOM_BIN ?? "axiom";
		this.printFlag = options.printFlag ?? "-p";
		this.timeoutMs = options.timeoutMs ?? 300_000;
	}
	async runCompletion(input: {
		sessionId: string;
		prompt: string;
		profile: GatewayProfile;
	}): Promise<{ reply: string; sessionId: string; error?: string }> {
		// Always pass --profile so the spawned agent resolves the profile home
		// (~/.axiom/profiles/<name>, incl. 'default') and reads that profile's
		// provider settings (e.g. ~/.axiom/profiles/default/settings.json).
		const args = [this.printFlag, input.prompt, "--profile", input.profile.name, "--session-id", input.sessionId];
		try {
			const stdout = await new Promise<string>((resolve, reject) => {
				const child = execFile(this.bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, out) =>
					err ? reject(err) : resolve(out),
				);
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`completion timed out after ${this.timeoutMs}ms: ${[this.bin, ...args].join(" ")}`));
				}, this.timeoutMs);
				// Don't keep the gateway's event loop alive waiting on the timer
				// once the child exits or errors normally.
				timer.unref?.();
			});
			return { reply: stdout.trimEnd(), sessionId: input.sessionId };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { reply: "", sessionId: input.sessionId, error: message };
		}
	}
}

/** A canned, injectable completion runner for router/e2e tests. */
export function fakeCompletionRunner(): CompletionRunner & { calls: Array<{ sessionId: string; prompt: string }> } {
	const runner: CompletionRunner & { calls: Array<{ sessionId: string; prompt: string }> } = {
		calls: [],
		async runCompletion(input) {
			this.calls.push({ sessionId: input.sessionId, prompt: input.prompt });
			return { reply: `axiom reply to: ${input.prompt}`, sessionId: input.sessionId };
		},
	};
	return runner;
}
