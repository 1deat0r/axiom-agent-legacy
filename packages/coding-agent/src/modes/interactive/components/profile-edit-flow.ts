/**
 * In-TUI profile file editing.
 *
 * Editing a profile file (SOUL.md / settings.json) needs an external editor,
 * but the TUI owns the terminal. The flow stops the TUI (leaving raw mode and
 * the alt screen, the same transition the Ctrl-Z suspend uses), runs the
 * editor as a BLOCKING child with inherited stdio, then restarts the TUI.
 * All side effects are injected so the flow is unit-testable.
 */

import {
	type EditorCommand,
	type EditorRunResult,
	formatEditorOutcome,
	type ProfileEditKind,
	resolveEditorCommand,
	resolveProfileEditTarget,
	runEditorSync,
} from "../../../cli/profile-command.js";

export interface ProfileEditFlowDeps {
	/** List profile names under the base profile home. */
	listProfiles(home: string): Promise<string[]>;
	/** Resolve the file to edit (injected for test determinism). */
	resolveTarget(home: string, name: string, kind: ProfileEditKind): { file: string };
	/** Resolve the editor command from the environment. */
	resolveEditor(): EditorCommand;
	/** Blocking editor spawn with inherited stdio. */
	spawnEditor(cmd: string, args: string[], file: string): EditorRunResult;
	/** TUI lifecycle: stop before the editor runs, start after it exits. */
	ui: { stop(): void; start(): void };
}

/**
 * Run the profile edit flow. Returns a one-line result for the caller to
 * print. Never throws: unknown profiles and non-zero editor exits return
 * error lines instead.
 */
export async function runProfileEditFlow(
	home: string,
	name: string,
	kind: ProfileEditKind,
	deps: ProfileEditFlowDeps,
): Promise<string> {
	const names = await deps.listProfiles(home);
	if (!names.includes(name)) {
		return names.length === 0
			? "No profiles yet — create one with 'profile create <name>'."
			: `Unknown profile '${name}' — existing: ${names.join(", ")}`;
	}
	const target = deps.resolveTarget(home, name, kind);
	const editor = deps.resolveEditor();
	deps.ui.stop();
	let result: EditorRunResult;
	try {
		result = deps.spawnEditor(editor.cmd, editor.args, target.file);
	} finally {
		deps.ui.start();
	}
	return formatEditorOutcome(name, kind, target.file, editor, result);
}

/** Build the default flow deps for the interactive TUI. */
export function defaultProfileEditFlowDeps(
	ui: ProfileEditFlowDeps["ui"],
	listProfiles: (home: string) => Promise<string[]>,
): ProfileEditFlowDeps {
	return {
		listProfiles,
		resolveTarget: resolveProfileEditTarget,
		resolveEditor: () => resolveEditorCommand(process.env),
		spawnEditor: (cmd, args, file) => runEditorSync(file, { cmd, args }),
		ui,
	};
}
