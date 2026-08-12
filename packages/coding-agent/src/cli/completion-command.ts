/**
 * `axiom completion` — shell tab-completion for the axiom CLI, driven by the
 * single source of truth (COMMAND_SPECS). `completion bash|zsh` prints a
 * completion function; the function shells back into `axiom completion
 * candidates -- <words...>` on each <Tab>, so the candidate list can never
 * drift from the command registry. Candidate computation lives in
 * completionCandidates() (pure, unit-tested); operand-value completion
 * (existing project names) reads the active profile's projects root.
 *
 * Returns true when the invocation was a completion command.
 */

import { axiomHome } from "../extensions/profile/registry.js";
import { getChildCommandSpecs } from "./command-registry.js";
import { listProjectNames } from "./projects-command.js";

export interface CompletionCommandIO {
	axiomHome?: string;
	stdout?(text: string): void;
}

export function handleCompletionCommand(args: string[], io: CompletionCommandIO = {}): Promise<boolean> {
	if (args[0] !== "completion") return Promise.resolve(false);
	return runCompletionCommand(args, io);
}

async function runCompletionCommand(args: string[], io: CompletionCommandIO): Promise<boolean> {
	const out = io.stdout ?? ((text: string) => console.log(text));
	const sub = args[1];
	if (sub === "bash") {
		out(emitBash());
		return true;
	}
	if (sub === "zsh") {
		out(emitZsh());
		return true;
	}
	if (sub === "candidates") {
		const sep = args.indexOf("--");
		const words = sep === -1 ? args.slice(2) : args.slice(sep + 1);
		const home = io.axiomHome ?? axiomHome();
		for (const candidate of await completionCandidates(words, home)) {
			out(candidate);
		}
		return true;
	}
	out("Usage: completion bash|zsh   print a shell completion script");
	return true;
}

/**
 * Candidate words for the given tokens typed so far. The LAST token is the
 * partial word being completed; the rest are committed. Subcommand segments
 * come from COMMAND_SPECS; operand values (existing project names) come from
 * the active profile's projects root. Filtered by the current prefix.
 */
export async function completionCandidates(words: readonly string[], home?: string): Promise<string[]> {
	const committed = words.slice(0, -1);
	const current = words.at(-1) ?? "";
	const out = new Set<string>();
	for (const child of getChildCommandSpecs(committed)) {
		out.add(child.path.at(-1)!);
	}
	if (committed.length === 2 && committed[0] === "projects" && committed[1] === "rm" && home !== undefined) {
		for (const name of await listProjectNames(home)) {
			out.add(name);
		}
	}
	return [...out].filter((name) => current === "" || name.startsWith(current)).sort();
}

export function emitBash(): string {
	return [
		`_axiom_completion() {`,
		`  local words candidates`,
		`  words=("\${COMP_WORDS[@]:1:COMP_CWORD}")`,
		`  local IFS=$'\\n'`,
		`  candidates=($(axiom completion candidates -- "\${words[@]}" 2>/dev/null))`,
		`  COMPREPLY=($(compgen -W "\${candidates[*]}" -- "\${COMP_WORDS[COMP_CWORD]}"))`,
		`}`,
		`complete -F _axiom_completion axiom`,
	].join("\n");
}

export function emitZsh(): string {
	return [
		`#compdef axiom`,
		`_axiom_completion() {`,
		`  local -a args candidates`,
		`  args=("\${words[@]:1}")`,
		`  local IFS=$'\\n'`,
		`  candidates=($(axiom completion candidates -- "\${args[@]}" 2>/dev/null))`,
		`  _describe 'axiom' candidates`,
		`}`,
		`compdef _axiom_completion axiom`,
	].join("\n");
}
